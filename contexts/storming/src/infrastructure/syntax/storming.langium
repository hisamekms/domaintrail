// The Event Storming DSL `.dtes` (docs/dtes-v0.1.md, ADR 0024, ADR 0032). Every rule and type starts with `Es`, so the
// AST types generated next to the `.dt` ones never collide. The grammar is permissive where the validator gives better
// messages: every element may have a body and every body takes every clause; which clauses an element may have, how
// many, and the kinds of their targets are rules S003–S009, S016 and S023–S028 (domain/validate.ts), not syntax errors;
// so are the number and targets of a stage's `after` and a timeline's `then` (S002–S004, S017–S021).
grammar EventStorming

entry EsFile:
    stormings+=EsStorming*;

EsStorming:
    'storming' name=ID label=STRING? '{' elements+=EsElement* '}';

EsElement:
    EsNode | EsTimeline | EsStage;

EsNode:
    EsEvent | EsActor | EsExternal | EsCommand | EsPolicy | EsAggregate | EsReadModel | EsHotspot;

// Every declaration of a storming, stages, their timelines and groups included: the targets of local references (one
// namespace per storming).
type EsDeclaration = EsNode | EsTimeline | EsGroup | EsStage;

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
    EsRefClause | EsRelationClause | EsStatusClause | EsResolutionClause | EsLevelClause;

// `ref Delivery.Shipment.cancel`: a fully qualified `.dt` symbol, resolved against the Typed Model (not linked here).
EsRefClause:
    'ref' path=EsPath;

// References to declarations of the same storming, whatever their kind (a wrong kind is S003): `emits A, B` is
// `emits A` and `emits B`. The relations are Event Storming's design-level grammar (ADR 0032): a command is issued `by`
// an actor or external system, who `reads` a read model to decide it; it is `handledBy` an aggregate or external
// system, which `emits` its events; a policy is `on` events and `issues` commands; a read model is fed `from` events,
// an event arrives `from` an external system; a hotspot is `on` any sticky. `actor` and `target`, the relations of
// v0.1, are parsed only to be reported with their replacement (S023).
EsRelationClause:
    keyword=EsRelationKeyword targets+=[EsDeclaration:ID] (',' targets+=[EsDeclaration:ID])*;

EsRelationKeyword returns string:
    'by' | 'reads' | 'handledBy' | 'emits' | 'on' | 'issues' | 'from' | 'actor' | 'target';

// Any word: only `open` and `resolved` are valid (S009).
EsStatusClause:
    'status' value=EsName;

EsResolutionClause:
    'resolution' text=STRING;

// `level design`: an event shown at Design Level only. Any word, hyphens included: only `design` is valid (S016), and
// `big-picture` gets a message of its own rather than a syntax error.
EsLevelClause:
    'level' value=EsLevelValue;

EsLevelValue returns string:
    EsName ('-' EsName)*;

// A time section of the flow: its main flows (`timeline`s, the first one its trunk) and the exceptions within it.
// `after` orders the stages (any number is written, at most one is valid: S004); the events stay declared in the
// storming.
EsStage:
    'stage' name=ID label=STRING? afters+=EsAfterClause* '{' timelines+=EsTimeline* '}';

EsAfterClause:
    'after' stage=[EsDeclaration:ID];

// A partial time order: event references and groups only. `timeline` is a main flow, `exception` an exception from
// it; an exception may end with `then <Event>`, the event of a main flow it returns to (on a main flow: S018).
EsTimeline:
    ('timeline' | exception?='exception') name=ID label=STRING? '{' steps+=EsStep* rejoin=EsRejoin? '}';

EsRejoin:
    'then' event=[EsDeclaration:ID];

EsStep:
    EsEventStep | EsGroup;

EsEventStep:
    event=[EsDeclaration:ID];

// Events of one step, without an order among them.
EsGroup:
    'group' name=ID label=STRING? '{' events+=EsEventStep+ '}';

// The segments after the first may be keywords: a `.dt` command may be named `target` or `status`.
EsPath returns string:
    ID ('.' EsName)*;

EsName returns string:
    ID | 'storming' | 'event' | 'actor' | 'external' | 'command' | 'policy' | 'aggregate' | 'readmodel' | 'hotspot' |
    'timeline' | 'group' | 'ref' | 'by' | 'reads' | 'handledBy' | 'target' | 'emits' | 'on' | 'issues' | 'from' |
    'status' | 'resolution' | 'level' | 'stage' | 'after' | 'then' | 'exception';

// The terminals of Modeling's grammar (contexts/modeling/src/infrastructure/syntax/domain.langium), copied verbatim
// (test/grammars.test.ts keeps them equal); INT and DECIMAL are unused.
hidden terminal WS: /\s+/;
terminal STRING: /"(\\.|[^"\\])*"/;
terminal ID: /[_a-zA-Z][\w_]*/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
