import {
    AstUtils,
    DefaultScopeComputation,
    DefaultScopeProvider,
    EmptyFileSystem,
    createDefaultCoreModule,
    createDefaultSharedCoreModule,
    inject,
    type AstNode,
    type AstNodeDescription,
    type LangiumCoreServices,
    type LangiumDocument,
    type LangiumSharedCoreServices,
    type ReferenceInfo,
    type Scope,
} from 'langium';
import { Context, State, isContext, type Model } from './generated/ast.js';
import { DomainGeneratedModule, DomainGeneratedSharedModule } from './generated/module.js';

/** Export prefix for elements of shared contexts, which are visible by simple name everywhere. */
export const SHARED_PREFIX = '$shared.';

/**
 * Exports every context element under its fully qualified name (`Context.Name`).
 * A context may be split across several files; all of them contribute to the same namespace.
 * Elements of shared contexts are additionally exported as `$shared.Name`.
 */
export class DomainScopeComputation extends DefaultScopeComputation {
    override async collectExportedSymbols(document: LangiumDocument): Promise<AstNodeDescription[]> {
        const model = document.parseResult.value as Model;
        const exports: AstNodeDescription[] = [];
        for (const ctx of model.contexts ?? []) {
            if (!ctx.name) continue;
            for (const el of ctx.elements) {
                if (el.name) {
                    exports.push(this.descriptions.createDescription(el, `${ctx.name}.${el.name}`, document));
                    if (ctx.shared) exports.push(this.descriptions.createDescription(el, `${SHARED_PREFIX}${el.name}`, document));
                }
            }
        }
        return exports;
    }
}

/**
 * Inside a context, elements of the same context (from any file) are visible by simple name, then elements
 * of shared contexts. Elements of other contexts must be referenced by their fully qualified name.
 * State references are resolved within the owning aggregate (Langium's default local scoping).
 */
export class DomainScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const referenceType = this.reflection.getReferenceType(context);
        if (referenceType === State.$type) {
            return super.getScope(context);
        }
        const all = this.indexManager.allElements(referenceType).toArray();
        const qualified = this.createScope(all.filter((d) => !d.name.startsWith(SHARED_PREFIX)));
        const shared = this.createScope(
            all.filter((d) => d.name.startsWith(SHARED_PREFIX)).map((d) => ({ ...d, name: d.name.slice(SHARED_PREFIX.length) })),
            qualified,
        );
        const ctx = AstUtils.getContainerOfType(context.container, isContext);
        if (!ctx?.name) return shared;
        const prefix = `${ctx.name}.`;
        const local = all
            .filter((d) => d.name.startsWith(prefix) && !d.name.slice(prefix.length).includes('.'))
            .map((d) => ({ ...d, name: d.name.slice(prefix.length) }));
        return this.createScope(local, shared);
    }
}

export type DomainServices = LangiumCoreServices;

export const DomainModule = {
    references: {
        ScopeComputation: (services: LangiumCoreServices) => new DomainScopeComputation(services),
        ScopeProvider: (services: LangiumCoreServices) => new DomainScopeProvider(services),
    },
};

export function createDomainServices(): { shared: LangiumSharedCoreServices; Domain: DomainServices } {
    const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), DomainGeneratedSharedModule);
    const Domain = inject(createDefaultCoreModule({ shared }), DomainGeneratedModule, DomainModule);
    shared.ServiceRegistry.register(Domain);
    return { shared, Domain };
}

export function qualifiedName(node: AstNode & { name?: string }): string {
    const ctx = AstUtils.getContainerOfType(node, isContext) as Context | undefined;
    return ctx && node !== ctx ? `${ctx.name}.${node.name}` : (node.name ?? '');
}
