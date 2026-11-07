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

import {Inject, Injectable} from '@angular/core';
import {ZITI_DATA_SERVICE, ZitiDataService} from '../../services/ziti-data.service';
import {ManagementPermissionsService} from '../../services/management-permissions.service';
import {
    AcErPolicy, AcIdentity, AcModel, AcOp, AcRouter, AcSerp, AcService, AcServicePolicy,
    erPolicyBody, policyBody,
} from './access-canvas.logic';

/** One request that undoes one applied op. */
export interface AcRevert { label: string; run: () => Promise<any>; }

const PAGE = 500;
const isEmptyObj = (o: any) => !o || (typeof o === 'object' && Object.keys(o).length === 0);

@Injectable({providedIn: 'root'})
export class AccessCanvasService {

    constructor(
        @Inject(ZITI_DATA_SERVICE) private data: ZitiDataService,
        private permissions: ManagementPermissionsService,
    ) {}

    /** True when the signed-in admin may change identities and both policy types. */
    canEdit(): boolean {
        const p = this.permissions;
        return p.canUpdate('identities') && p.canCreate('service-policies') && p.canUpdate('service-policies') && p.canCreate('edge-router-policies');
    }

    private async all(type: string): Promise<any[]> {
        const out: any[] = [];
        for (let page = 1; page < 1000; page++) {
            const paging = {filter: '', noSearch: true, order: 'asc', page, searchOn: 'name', sort: 'name', total: PAGE};
            const res = await this.data.get(type, paging, []);
            const rows = res?.data || [];
            out.push(...rows);
            const total = res?.meta?.pagination?.totalCount ?? out.length;
            if (!rows.length || out.length >= total) break;
        }
        return out;
    }

    async load(): Promise<AcModel> {
        const [ids, svcs, ers, sps, erps, serps] = await Promise.all([
            this.all('identities'), this.all('services'), this.all('edge-routers'),
            this.all('service-policies'), this.all('edge-router-policies'), this.all('service-edge-router-policies'),
        ]);
        const identities: AcIdentity[] = ids.map(i => ({
            id: i.id, name: i.name, attrs: i.roleAttributes || [],
            // Pending enrollments are listed under `enrollment`; an enrolled identity has an authenticator.
            enrolled: !isEmptyObj(i.authenticators) || isEmptyObj(i.enrollment),
            online: !!i.hasEdgeRouterConnection,
            isAdmin: !!i.isAdmin,
        }));
        const services: AcService[] = svcs.map(s => ({id: s.id, name: s.name, attrs: s.roleAttributes || []}));
        const routers: AcRouter[] = ers.map(r => ({id: r.id, name: r.name, attrs: r.roleAttributes || [], online: !!r.isOnline}));
        const servicePolicies: AcServicePolicy[] = sps.map(p => ({
            id: p.id, name: p.name, type: p.type, semantic: p.semantic || 'AnyOf',
            identityRoles: p.identityRoles || [], serviceRoles: p.serviceRoles || [],
            posture: p.postureCheckRolesDisplay?.length
                ? p.postureCheckRolesDisplay.map((x: any) => x.name || x.role)
                : (p.postureCheckRoles || []),
        }));
        const erPolicies: AcErPolicy[] = erps.map(p => ({
            id: p.id, name: p.name, semantic: p.semantic || 'AnyOf',
            identityRoles: p.identityRoles || [], routerRoles: p.edgeRouterRoles || [],
        }));
        const serpsOut: AcSerp[] = serps.map(p => ({
            id: p.id, name: p.name, semantic: p.semantic || 'AnyOf',
            serviceRoles: p.serviceRoles || [], routerRoles: p.edgeRouterRoles || [],
        }));
        return {identities, services, routers, servicePolicies, erPolicies, serps: serpsOut};
    }

    /**
     * Sends ops in order against the latest committed model. Returns revert actions for the
     * ops that succeeded; on failure the error is thrown with `reverts` attached so the caller
     * can roll back what already went through.
     */
    async apply(committed: AcModel, ops: AcOp[]): Promise<AcRevert[]> {
        const reverts: AcRevert[] = [];
        // Attributes and roles accumulate across ops on the same entity.
        const attrs = new Map(committed.identities.map(i => [i.id, [...i.attrs]]));
        const roles = new Map(committed.servicePolicies.map(p => [p.id, [...p.identityRoles]]));
        try {
            for (const op of ops) {
                if (op.op === 'addAttr') {
                    const before = attrs.get(op.identity) || [];
                    const after = before.includes(op.attr) ? before : [...before, op.attr];
                    await this.data.patch('identities', {roleAttributes: after}, op.identity);
                    attrs.set(op.identity, after);
                    reverts.unshift({label: `restore attributes on identity ${op.identity}`, run: () => this.data.patch('identities', {roleAttributes: before}, op.identity)});
                } else if (op.op === 'addIdentityRole') {
                    const before = roles.get(op.policy) || [];
                    const after = before.includes(op.role) ? before : [...before, op.role];
                    await this.data.patch('service-policies', {identityRoles: after}, op.policy);
                    roles.set(op.policy, after);
                    reverts.unshift({label: `restore identity roles on policy ${op.policy}`, run: () => this.data.patch('service-policies', {identityRoles: before}, op.policy)});
                } else if (op.op === 'createPolicy') {
                    const res = await this.data.post('service-policies', policyBody(op.policy));
                    const id = res?.data?.id;
                    if (id) reverts.unshift({label: `delete service policy ${op.policy.name}`, run: () => this.data.delete('service-policies', id)});
                } else if (op.op === 'createErPolicy') {
                    const res = await this.data.post('edge-router-policies', erPolicyBody(op.policy));
                    const id = res?.data?.id;
                    if (id) reverts.unshift({label: `delete edge router policy ${op.policy.name}`, run: () => this.data.delete('edge-router-policies', id)});
                }
            }
        } catch (err: any) {
            err.reverts = reverts;
            throw err;
        }
        return reverts;
    }

    async revert(reverts: AcRevert[]): Promise<void> {
        for (const r of reverts) await r.run();
    }

    errorText(err: any): string {
        if (err instanceof Error) return err.message;
        const e = err?.error?.error || err?.error || err;
        const text = e?.cause?.reason || e?.message || e?.code || (typeof e === 'string' ? e : '');
        if (text) return text;
        if (err?.status) return `HTTP ${err.status} ${err.statusText || ''}`.trim();
        try { return 'Unexpected error: ' + JSON.stringify(err).slice(0, 200); } catch { return 'Unexpected error'; }
    }
}
