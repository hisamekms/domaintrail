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
    type LangiumSharedCoreServices,
    type ReferenceInfo,
    type Scope,
} from 'langium';
import { isEsGroup, isEsStorming, isEsTimeline, type EsDeclaration, type EsStorming } from '../../language/generated/ast.js';
import { DomainGeneratedSharedModule, EventStormingGeneratedModule } from '../../language/generated/module.js';
import { DomainParserErrorMessageProvider } from '../../language/parser-messages.js';

/** Every declaration of a storming in source order, the groups of its timelines included: one namespace (spec §2). */
export function stormingDeclarations(storming: EsStorming): EsDeclaration[] {
    return storming.elements.flatMap((el): EsDeclaration[] => (isEsTimeline(el) ? [el, ...el.steps.filter(isEsGroup)] : [el]));
}

/** A storming's declarations are not visible outside it: nothing is exported to the workspace. */
export class EventStormingScopeComputation extends DefaultScopeComputation {
    override collectExportedSymbols(): Promise<AstNodeDescription[]> {
        return Promise.resolve([]);
    }
}

/**
 * A local reference (`target Shipment`, a timeline step) sees every declaration of its storming, whatever the kind, so
 * that a wrong kind is reported by the validator (S003) rather than as a linking error. The first of duplicate IDs wins
 * (duplicates are S001).
 */
export class EventStormingScopeProvider extends DefaultScopeProvider {
    override getScope(context: ReferenceInfo): Scope {
        const storming = AstUtils.getContainerOfType(context.container, isEsStorming);
        return this.createScopeForNodes(storming ? stormingDeclarations(storming) : ([] as AstNode[]));
    }
}

export type EventStormingServices = LangiumCoreServices;

export const EventStormingModule = {
    parser: {
        ParserErrorMessageProvider: () => new DomainParserErrorMessageProvider(),
    },
    references: {
        ScopeComputation: (services: LangiumCoreServices) => new EventStormingScopeComputation(services),
        ScopeProvider: (services: LangiumCoreServices) => new EventStormingScopeProvider(services),
    },
};

export function createStormingServices(): { shared: LangiumSharedCoreServices; EventStorming: EventStormingServices } {
    const shared = inject(createDefaultSharedCoreModule(EmptyFileSystem), DomainGeneratedSharedModule);
    const EventStorming = inject(createDefaultCoreModule({ shared }), EventStormingGeneratedModule, EventStormingModule);
    shared.ServiceRegistry.register(EventStorming);
    return { shared, EventStorming };
}
