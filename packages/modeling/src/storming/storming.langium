// The Event Storming DSL `.dtes` (docs/dtes-v0.1.md, ADR 0024). Every rule and type starts with `Es`, so the AST types
// generated next to the `.dt` ones never collide. The grammar is permissive where the validator gives better messages:
// every element may have a body and every body takes every clause; which clauses an element may have, how many, and the
// kinds of their targets are rules S003–S009 (src/dtes/validate.ts), not syntax errors.
grammar EventStorming

entry EsFile:
    stormings+=EsStorming*;

EsStorming:
    'storming' name=ID label=STRING? '{' elements+=EsElement* '}';

EsElement:
    EsNode | EsTimeline;

EsNode:
    EsEvent | EsActor | EsExternal | EsCommand | EsPolicy | EsAggregate | EsReadModel | EsHotspot;

// Every declaration of a storming, groups included: the targets of local references (one namespace per storming).
type EsDeclaration = EsNode | EsTimeline | EsGroup;

EsEvent:
    'event' EsNodeBody;

EsActor:
    'actor' EsNodeBody;

EsExternal:
    'external' EsNodeBody;

EsCommand:
    'command' EsNodeBody;

EsPolicy:
    'policy' EsNodeBody;

EsAggregate:
    'aggregate' EsNodeBody;

EsReadModel:
    'readmodel' EsNodeBody;

// The label of a hotspot is its question.
EsHotspot:
    'hotspot' EsNodeBody;

fragment EsNodeBody:
    name=ID label=STRING? ('{' clauses+=EsClause* '}')?;

EsClause:
    EsRefClause | EsRelationClause | EsStatusClause | EsResolutionClause;

// `ref Delivery.Shipment.cancel`: a fully qualified `.dt` symbol, resolved against the Typed Model (not linked here).
EsRefClause:
    'ref' path=EsPath;

// A reference to a declaration of the same storming, whatever its kind (a wrong kind is S003).
EsRelationClause:
    keyword=EsRelationKeyword target=[EsDeclaration:ID];

EsRelationKeyword returns string:
    'actor' | 'reads' | 'target' | 'emits' | 'on' | 'issues';

// Any word: only `open` and `resolved` are valid (S009).
EsStatusClause:
    'status' value=EsName;

EsResolutionClause:
    'resolution' text=STRING;

// A partial time order: event references and groups only.
EsTimeline:
    'timeline' name=ID label=STRING? '{' steps+=EsStep* '}';

EsStep:
    EsEventStep | EsGroup;

EsEventStep:
    event=[EsDeclaration:ID];

// Events of one stage, without an order among them.
EsGroup:
    'group' name=ID label=STRING? '{' events+=EsEventStep+ '}';

// The segments after the first may be keywords: a `.dt` command may be named `target` or `status`.
EsPath returns string:
    ID ('.' EsName)*;

EsName returns string:
    ID | 'storming' | 'event' | 'actor' | 'external' | 'command' | 'policy' | 'aggregate' | 'readmodel' | 'hotspot' |
    'timeline' | 'group' | 'ref' | 'reads' | 'target' | 'emits' | 'on' | 'issues' | 'status' | 'resolution';

// The terminals of src/language/domain.langium, copied verbatim (a test keeps them equal); INT and DECIMAL are unused.
hidden terminal WS: /\s+/;
terminal STRING: /"(\\.|[^"\\])*"/;
terminal ID: /[_a-zA-Z][\w_]*/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
