/*
    Copyright NetFoundry Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    https://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/

import {
    AfterViewChecked, ChangeDetectorRef, Component, ElementRef, NgZone, OnDestroy, OnInit, ViewChild, ViewEncapsulation,
} from '@angular/core';
import {CommonModule} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Router} from '@angular/router';
import {GrowlerService} from '../messaging/growler.service';
import {GrowlerModel} from '../messaging/growler.model';
import {AccessCanvasService, AcRevert} from './access-canvas.service';
import {
    AcEndpoint, AcGrantResult, AcGuideStep, AcIdentity, AcModel, AcOp, AcService, AcServicePolicy, AcStep,
    CONCEPTS, accessSet, advise, applyOps, buildOptions, clients, clone, describeCalls, dialFor, groups, guideSteps,
    hosts, hostsFor, identityRouters, roleLabel,
} from './access-canvas.logic';

interface Pending { id: string; title: string; summary: string; ops: AcOp[]; calls: string[]; }
interface Applied { title: string; reverts: AcRevert[]; }
interface Edge { a: string; b: string; cls: string; p: string; }
interface GroupVm<T> { key: string; attr: string; members: T[]; shown: T[]; more: number; open: boolean; services?: number; unrouted?: number; unenrolled?: number; }

const CAP = 8;

@Component({
    selector: 'lib-access-canvas',
    standalone: true,
    imports: [CommonModule, FormsModule],
    templateUrl: './access-canvas.component.html',
    styleUrls: ['./access-canvas.component.scss'],
    encapsulation: ViewEncapsulation.None,
})
export class AccessCanvasComponent implements OnInit, AfterViewChecked, OnDestroy {
    @ViewChild('flow') flowRef?: ElementRef<HTMLElement>;
    @ViewChild('edges') edgesRef?: ElementRef<SVGSVGElement>;

    readonly concepts = CONCEPTS;
    loading = true;
    busy = false;
    loadError = '';
    readOnly = false;

    committed: AcModel | null = null;
    draft: AcModel | null = null;
    pending: Pending[] = [];
    history: Applied[] = [];

    filter = '';
    expanded = new Set<string>();
    shownConcepts = new Set<string>();
    guideOpen = true;
    advisorPassed = false;

    // view models
    idGroups: GroupVm<AcIdentity>[] = [];
    svcGroups: GroupVm<AcService>[] = [];
    hostGroups: GroupVm<AcIdentity>[] = [];
    dials: AcServicePolicy[] = [];
    binds: AcServicePolicy[] = [];
    guide: AcGuideStep[] = [];
    guideDone = 0;
    marks = new Set<string>();
    advisorClients: GroupVm<AcIdentity>[] = [];

    advisorI = '';
    advisorS = '';
    advice: AcStep[] = [];
    adviceFail: AcStep | null = null;
    advicePosture = false;

    dialog: { src: AcEndpoint; tgt: AcEndpoint | null; result?: AcGrantResult; selected: number; } | null = null;
    dragging = false;
    overKey = '';

    private edges: Edge[] = [];
    private edgesDirty = true;
    private resizeObs?: ResizeObserver;
    private seq = 1;

    constructor(
        private svc: AccessCanvasService,
        private growler: GrowlerService,
        private router: Router,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit(): void {
        this.readOnly = !this.svc.canEdit();
        this.reload();
    }

    ngAfterViewChecked(): void {
        if (this.flowRef && !this.resizeObs) {
            this.zone.runOutsideAngular(() => {
                this.resizeObs = new ResizeObserver(() => requestAnimationFrame(() => this.drawEdges()));
                this.resizeObs.observe(this.flowRef!.nativeElement);
            });
        }
        if (this.edgesDirty) {
            this.edgesDirty = false;
            this.zone.runOutsideAngular(() => requestAnimationFrame(() => this.drawEdges()));
        }
    }

    ngOnDestroy(): void {
        this.resizeObs?.disconnect();
    }

    // ------------------------------------------------------------------ data
    async reload(): Promise<void> {
        this.loading = !this.committed;
        this.loadError = '';
        let stage = 'loading the network';
        try {
            this.committed = await this.svc.load();
            stage = 'drawing the canvas';
            this.refresh();
        } catch (err) {
            console.error('[access-canvas] failed while ' + stage, err);
            this.loadError = `${this.svc.errorText(err)} (while ${stage})`;
        } finally {
            this.loading = false;
            this.cdr.markForCheck();
        }
    }

    private newId = () => `new-${this.seq++}`;

    refresh(): void {
        if (!this.committed) return;
        const m = this.draft = this.pending.reduce((acc, c) => applyOps(acc, c.ops), clone(this.committed));
        this.marks = this.pendingMarks();
        const f = this.filter.trim().toLowerCase().replace(/^[#@]/, '');
        const hit = (e: { name: string; attrs: string[] }) => !f || e.name.toLowerCase().includes(f) || e.attrs.some(a => a.toLowerCase().includes(f));
        const filtered = <T extends { name: string; attrs: string[] }>(list: T[]) =>
            groups(list as any as (T & { id: string })[])
                .map(([a, ms]) => [a, f && !a.toLowerCase().includes(f) ? ms.filter(hit) : ms] as [string, T[]])
                .filter(([, ms]) => ms.length);

        this.idGroups = filtered(clients(m)).map(([a, ms]) => {
            const key = 'idg:' + a;
            const open = this.expanded.has(key) || !!f;
            return {
                key, attr: a, members: ms, open, shown: f ? ms : ms.slice(0, CAP), more: f ? 0 : Math.max(0, ms.length - CAP),
                services: new Set(ms.flatMap(i => m.services.filter(s => dialFor(m, i, s).length).map(s => s.id))).size,
                unrouted: ms.filter(i => !identityRouters(m, i).length).length,
                unenrolled: ms.filter(i => !i.enrolled).length,
            };
        });
        this.svcGroups = filtered(m.services).map(([a, ms]) => ({key: 'svcg:' + a, attr: a, members: ms, shown: ms, more: 0, open: true}));
        this.hostGroups = filtered(hosts(m)).map(([a, ms]) => ({key: 'hg:' + a, attr: a, members: ms, shown: ms, more: 0, open: true}));
        this.dials = m.servicePolicies.filter(p => p.type === 'Dial');
        this.binds = m.servicePolicies.filter(p => p.type === 'Bind');
        this.advisorClients = groups(clients(m)).map(([a, ms]) => ({key: a, attr: a, members: ms, shown: ms, more: 0, open: true}));
        this.buildEdges(m);
        this.runAdvisor();
        this.guide = guideSteps(m, {pending: this.pending.length, advisorPassed: this.advisorPassed});
        this.guideDone = this.guide.filter(s => s.done).length;
        this.edgesDirty = true;
    }

    private pendingMarks(): Set<string> {
        const s = new Set<string>();
        for (const c of this.pending) for (const op of c.ops) {
            if (op.op === 'addAttr') s.add(`attr:${op.identity}:${op.attr}`);
            if (op.op === 'addIdentityRole') s.add(`role:${op.policy}:${op.role}`);
            if (op.op === 'createPolicy' || op.op === 'createErPolicy') s.add(`policy:${op.policy.id}`);
        }
        return s;
    }

    // ------------------------------------------------------------------ helpers for the template
    role(r: string): string { return this.draft ? roleLabel(this.draft, r) : r; }
    hostCount(s: AcService): number { return this.draft ? hostsFor(this.draft, s).length : 0; }
    trackKey = (_: number, g: GroupVm<any>) => g.key;
    trackId = (_: number, e: { id: string }) => e.id;
    otherAttrs(i: AcIdentity, a: string): string[] { return i.attrs.filter(x => x !== a); }
    plural(n: number, one: string, many: string): string { return `${n} ${n === 1 ? one : many}`; }
    srcOf(kind: 'group' | 'identity', v: string): AcEndpoint { return kind === 'group' ? {kind, attr: v} : {kind, id: v}; }

    get erPolicies() { return this.draft?.erPolicies || []; }
    get serps() { return this.draft?.serps || []; }
    get routerGroups() { return this.draft ? groups(this.draft.routers) : []; }
    get pendingCalls(): number { return this.pending.reduce((n, c) => n + c.ops.length, 0); }
    get nextGuide(): AcGuideStep | undefined { return this.guide.find(s => !s.done); }

    toggleGroup(key: string): void {
        this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key);
        this.refresh();
    }
    toggleConcept(c: string): void {
        this.shownConcepts.has(c) ? this.shownConcepts.delete(c) : this.shownConcepts.add(c);
        this.edgesDirty = true;
    }
    onFilter(): void { this.refresh(); }
    toggleGuide(): void { this.guideOpen = !this.guideOpen; this.edgesDirty = true; }
    go(route: string): void { this.router.navigate([route]); }

    // ------------------------------------------------------------------ edges
    private buildEdges(m: AcModel): void {
        const edges: Edge[] = [];
        const cg = this.idGroups.map(g => g.attr), hg = this.hostGroups.map(g => g.attr), sg = this.svcGroups.map(g => g.attr);
        const firstGroup = (attrs: string[], pre: string, avail: string[]) => {
            const a = attrs.find(x => avail.includes(x)) ?? (avail.includes('') && !attrs.length ? '' : undefined);
            return a === undefined ? [] : [pre + a];
        };
        for (const p of m.servicePolicies) {
            const isDial = p.type === 'Dial', pk = (isDial ? 'dp:' : 'bp:') + p.id;
            const pend = this.marks.has(`policy:${p.id}`);
            for (const r of p.identityRoles) {
                const avail = isDial ? cg : hg, pre = isDial ? 'idg:' : 'hg:';
                let keys: string[] = [];
                if (r === '#all') keys = avail.map(a => pre + a);
                else if (r[0] === '#') keys = avail.includes(r.slice(1)) ? [pre + r.slice(1)] : [];
                else { const e = m.identities.find(x => '@' + x.id === r || '@' + x.name === r); if (e) keys = firstGroup(e.attrs, pre, avail); }
                const cls = [isDial ? 'dial' : 'bind', r[0] === '@' ? 'byname' : '', pend || this.marks.has(`role:${p.id}:${r}`) ? 'pending' : ''].join(' ');
                keys.forEach(k => edges.push({a: k, b: pk, cls, p: p.id}));
            }
            for (const r of p.serviceRoles) {
                let keys: string[] = [];
                if (r === '#all') keys = sg.map(a => 'svcg:' + a);
                else if (r[0] === '#') keys = sg.includes(r.slice(1)) ? ['svcg:' + r.slice(1)] : [];
                else { const s = m.services.find(x => '@' + x.id === r || '@' + x.name === r); if (s) keys = firstGroup(s.attrs, 'svcg:', sg); }
                const cls = [isDial ? 'dial' : 'bind', r[0] === '@' ? 'byname' : '', pend ? 'pending' : ''].join(' ');
                keys.forEach(k => edges.push({a: pk, b: k, cls, p: p.id}));
            }
        }
        this.edges = edges;
    }

    private drawEdges(): void {
        const flow = this.flowRef?.nativeElement, svg = this.edgesRef?.nativeElement;
        if (!flow || !svg || getComputedStyle(svg).display === 'none') return;
        const base = flow.getBoundingClientRect();
        const W = flow.scrollWidth, H = flow.scrollHeight;
        svg.setAttribute('width', String(W));
        svg.setAttribute('height', String(H));
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        const node = (k: string) => flow.querySelector(`[data-node="${CSS.escape(k)}"]`) as HTMLElement | null;
        const esc = (s: string) => s.replace(/"/g, '&quot;');
        svg.innerHTML = this.edges.map(e => {
            const a = node(e.a), b = node(e.b);
            if (!a || !b) return '';
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            const y1 = ra.top - base.top + Math.min(20, ra.height / 2), y2 = rb.top - base.top + Math.min(20, rb.height / 2);
            let x1: number, x2: number;
            if (ra.right <= rb.left) { x1 = ra.right - base.left; x2 = rb.left - base.left; } else { x1 = ra.left - base.left; x2 = rb.right - base.left; }
            const dx = (x2 - x1) / 2;
            return `<path class="${e.cls}" data-p="${esc(e.p)}" data-a="${esc(e.a)}" data-b="${esc(e.b)}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}"/>`;
        }).join('');
    }

    focusCard(ev: Event): void {
        const card = (ev.target as HTMLElement).closest('.ac-card[data-node]') as HTMLElement | null;
        const flow = this.flowRef?.nativeElement, svg = this.edgesRef?.nativeElement;
        if (!card || !flow || !svg) return;
        this.unfocus();
        const pid = card.dataset['policy'], key = card.dataset['node'];
        const paths = Array.from(svg.querySelectorAll('path')) as SVGPathElement[];
        const hot = paths.filter(p => pid ? p.dataset['p'] === pid : (p.dataset['a'] === key || p.dataset['b'] === key));
        if (!hot.length) return;
        const pids = new Set(hot.map(p => p.dataset['p']));
        const allHot = paths.filter(p => pids.has(p.dataset['p']));
        allHot.forEach(p => p.classList.add('hot'));
        const keys = new Set(allHot.flatMap(p => [p.dataset['a'], p.dataset['b']]));
        flow.querySelectorAll('.ac-card[data-node]').forEach(c => c.classList.toggle('hot', keys.has((c as HTMLElement).dataset['node'])));
        svg.classList.add('focusing');
        flow.classList.add('focusing');
    }

    unfocus(): void {
        const flow = this.flowRef?.nativeElement, svg = this.edgesRef?.nativeElement;
        if (!flow || !svg) return;
        svg.classList.remove('focusing');
        flow.classList.remove('focusing');
        flow.querySelectorAll('.hot').forEach(x => x.classList.remove('hot'));
    }

    // ------------------------------------------------------------------ drag and drop
    onDragStart(ev: DragEvent, src: AcEndpoint): void {
        if (this.readOnly) { ev.preventDefault(); return; }
        ev.dataTransfer?.setData('text/plain', JSON.stringify(src));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'link';
        this.dragging = true;
    }
    onDragEnd(): void { this.dragging = false; this.overKey = ''; }
    onDragOver(ev: DragEvent, key: string): void {
        if (this.readOnly) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'link';
        this.overKey = key;
    }
    onDrop(ev: DragEvent, tgt: AcEndpoint): void {
        ev.preventDefault();
        ev.stopPropagation();
        this.dragging = false;
        this.overKey = '';
        if (this.readOnly) return;
        try { this.openGrant(JSON.parse(ev.dataTransfer?.getData('text/plain') || ''), tgt); } catch { /* not ours */ }
    }

    // ------------------------------------------------------------------ grant dialog
    openGrant(src: AcEndpoint, tgt: AcEndpoint | null): void {
        this.dialog = {src, tgt, selected: 0};
        this.computeGrant();
    }
    closeGrant(): void { this.dialog = null; }

    dialogTarget = '';
    get targetChoices(): { value: string; label: string; group: string }[] {
        if (!this.draft) return [];
        return [
            ...groups(this.draft.services).filter(([a]) => a).map(([a]) => ({value: JSON.stringify({kind: 'group', attr: a}), label: '#' + a, group: 'Service groups'})),
            ...this.draft.services.map(s => ({value: JSON.stringify({kind: 'service', id: s.id}), label: s.name, group: 'Services'})),
        ];
    }
    onTargetChange(): void {
        if (!this.dialog || !this.dialogTarget) return;
        this.dialog.tgt = JSON.parse(this.dialogTarget);
        this.computeGrant();
    }
    private computeGrant(): void {
        if (!this.dialog || !this.draft) return;
        const d = this.dialog;
        this.dialogTarget = d.tgt ? JSON.stringify(d.tgt) : '';
        d.result = d.tgt ? buildOptions(this.draft, d.src, d.tgt, this.newId) : undefined;
        d.selected = d.result ? Math.max(0, d.result.opts.findIndex(o => o.recommended)) : 0;
    }
    get dialogSourceLabel(): string {
        const d = this.dialog;
        if (!d || !this.draft) return '';
        return d.src.kind === 'group' ? '#' + d.src.attr : (this.draft.identities.find(i => i.id === d.src.id)?.name || '');
    }
    impactText(o: { impact: { pairs: number; identities: number; services: number } }): string {
        const i = o.impact;
        return i.pairs ? `Grants ${this.plural(i.identities, 'identity', 'identities')} access to ${this.plural(i.services, 'service', 'services')} (${this.plural(i.pairs, 'new pair', 'new pairs')}).` : 'No new access.';
    }
    queueSelected(): void {
        const d = this.dialog;
        if (!d?.result) return;
        const o = d.result.opts[d.selected];
        if (!o) return;
        const r = d.result, i = o.impact;
        this.queue(o.title,
            `${r.srcLabel} → ${r.tgtLabel}. ${i.pairs ? `${this.plural(i.identities, 'identity', 'identities')}, ${this.plural(i.services, 'service', 'services')}` : 'no new access'}${i.outside.length ? `; also ${i.outside.join(', ')}` : ''}${i.noRoute ? `; ${i.noRoute} without routers` : ''}.`,
            o.ops);
        this.dialog = null;
    }

    private queue(title: string, summary: string, ops: AcOp[]): void {
        if (!this.draft) return;
        this.pending.push({id: 'c' + this.seq++, title, summary, ops, calls: describeCalls(this.draft, ops)});
        this.refresh();
        this.toast('info', 'Added to pending changes', title);
    }

    allowAllRouters(): void {
        if (this.readOnly) return;
        this.queue('Allow all identities on all routers', 'Creates edge router policy #all → #all, the usual starting point. Narrow it later.',
            [{op: 'createErPolicy', policy: {id: this.newId(), name: 'all-identities-all-routers', semantic: 'AnyOf', identityRoles: ['#all'], routerRoles: ['#all']}}]);
    }

    discard(id: string): void { this.pending = this.pending.filter(c => c.id !== id); this.refresh(); }
    discardAll(): void { this.pending = []; this.refresh(); }

    async applyAll(): Promise<void> {
        if (!this.committed || !this.pending.length || this.readOnly || this.busy) return;
        this.busy = true;
        const sets = [...this.pending];
        let done = 0;
        try {
            for (const c of sets) {
                // Re-read between sets so each one patches the latest attributes and roles.
                if (done) this.committed = await this.svc.load();
                try {
                    const reverts = await this.svc.apply(this.committed!, c.ops);
                    this.history.push({title: c.title, reverts});
                    this.pending = this.pending.filter(p => p.id !== c.id);
                    done++;
                } catch (err: any) {
                    await this.svc.revert(err?.reverts || []).catch(() => undefined);
                    this.toast('error', 'Change not applied', `${c.title}: ${this.svc.errorText(err)}. Nothing from this change set was kept.`);
                    break;
                }
            }
            if (done) this.toast('success', 'Applied', `${this.plural(done, 'change set', 'change sets')} sent to the controller.`);
        } finally {
            this.busy = false;
            await this.reload();
        }
    }

    async undoLast(): Promise<void> {
        const last = this.history[this.history.length - 1];
        if (!last || this.busy) return;
        this.busy = true;
        try {
            await this.svc.revert(last.reverts);
            this.history.pop();
            this.toast('success', 'Undone', last.title);
        } catch (err) {
            this.toast('error', 'Undo failed', this.svc.errorText(err));
        } finally {
            this.busy = false;
            await this.reload();
        }
    }

    // ------------------------------------------------------------------ advisor
    runAdvisor(): void {
        const m = this.draft;
        if (!m) return;
        const cl = clients(m);
        if (!cl.some(i => i.id === this.advisorI)) this.advisorI = cl[0]?.id || '';
        if (!m.services.some(s => s.id === this.advisorS)) this.advisorS = m.services[0]?.id || '';
        const i = m.identities.find(x => x.id === this.advisorI), s = m.services.find(x => x.id === this.advisorS);
        if (!i || !s) { this.advice = []; this.adviceFail = null; return; }
        this.advice = advise(m, i, s);
        this.adviceFail = this.advice.find(x => x.st === 'bad') || null;
        this.advicePosture = this.advice.some(x => x.st === 'info');
        if (!this.adviceFail && !this.pending.length && !this.advisorPassed) {
            this.advisorPassed = true;
            this.guide = guideSteps(m, {pending: this.pending.length, advisorPassed: true});
            this.guideDone = this.guide.filter(st => st.done).length;
        }
    }
    get advisorIdentity() { return this.draft?.identities.find(i => i.id === this.advisorI); }
    get advisorService() { return this.draft?.services.find(s => s.id === this.advisorS); }
    pickIdentity(id: string): void { this.advisorI = id; this.runAdvisor(); }
    pickService(id: string): void { this.advisorS = id; this.runAdvisor(); }
    openIdentity(): void { if (this.advisorI) this.router.navigate(['/identities', this.advisorI]); }

    // ------------------------------------------------------------------ misc
    private toast(level: string, title: string, content: string): void {
        this.growler.show(new GrowlerModel(level, title, 'Access Canvas', content));
    }

    get accessPairs(): number { return this.draft ? accessSet(this.draft).size : 0; }
}
