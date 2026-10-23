grammar Domain

entry Model:
    contexts+=Context*;

// A shared context (shared kernel) holds value types usable by name from every context.
Context:
    (shared?='shared')? 'context' name=ID label=STRING? '{' (elements+=ContextElement | terms+=Terms)* '}';

// Japanese (display) names of fields and parameters, defined once per name in a context.
Terms:
    'terms' '{' entries+=TermEntry* '}';

TermEntry:
    name=FeatureName ':' label=STRING;

ContextElement:
    IdType | PrimitiveDecl | EnumDecl | ValueObject | UnionDecl | Entity | Aggregate | EventDecl | ErrorDecl | FieldSet;

// Types that may appear on the right-hand side of a field declaration.
type TypeDecl = IdType | PrimitiveDecl | EnumDecl | ValueObject | UnionDecl | Entity | Aggregate;

// Domain primitives: a single value wrapping a primitive type, with optional invariants on `value`.
// An ID is a domain primitive that identifies an aggregate or entity.
IdType:
    'id' name=ID label=STRING? ':' base=PrimitiveType PrimitiveBody?;

PrimitiveDecl:
    'primitive' name=ID label=STRING? ':' base=PrimitiveType PrimitiveBody?;

// Either named invariants, or a single anonymous constraint: `{ value > 0 }`.
fragment PrimitiveBody:
    '{' (invariants+=Invariant+ | constraint=Expression) '}';

EnumDecl:
    'enum' name=ID label=STRING? '{' (values+=EnumValue (','? values+=EnumValue)*)? '}';

EnumValue:
    name=ID label=STRING?;

ValueObject:
    'value' name=ID label=STRING? WithFieldSets? ('{' members+=DataMember* '}')?;

// Fields that several aggregates, entities or events take on with `with`: plain fields only.
FieldSet:
    'fields' name=ID label=STRING? WithFieldSets? '{' members+=DataMember* '}';

// `with A, B`: the fields of field sets, placed before the element's own fields. Only aggregates, entities and events
// take field sets; elsewhere (and nested in a field set) it is reported by M016.
fragment WithFieldSets:
    'with' fieldSets+=[FieldSet:QualifiedName] (',' fieldSets+=[FieldSet:QualifiedName])*;

// A value whose shape depends on a fixed kind: a tagged union of variants. The discriminator is `kind` unless
// named with `by`; `by name: Enum` binds its values to an enum.
UnionDecl:
    'union' name=ID label=STRING? ('by' discriminator=FeatureName (':' tagType=[EnumDecl:QualifiedName])?)?
    '{' variants+=Variant* '}';

Variant:
    name=ID label=STRING? ('{' members+=DataMember* '}')?;

Entity:
    'entity' name=ID label=STRING? WithFieldSets? '{' members+=DataMember* '}';

Aggregate:
    'aggregate' name=ID label=STRING? WithFieldSets? '{' members+=AggregateMember* '}';

AggregateMember:
    DataMember | State | Command;

DataMember:
    Field | OwnsField | ReferenceField | Invariant;

State:
    'state' name=ID label=STRING? ('{' members+=DataMember* '}')?;

Field:
    name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? label=STRING?;

OwnsField:
    'owns' name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? label=STRING?;

ReferenceField:
    'references' name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? '->' target=[Aggregate:QualifiedName] label=STRING?;

Command:
    (factory?='create')? 'command' name=FeatureName '(' (params+=Parameter (',' params+=Parameter)*)? ')' label=STRING?
    (transitions+=Transition (','? transitions+=Transition)*)?
    ('emits' emits+=[EventDecl:QualifiedName] (',' emits+=[EventDecl:QualifiedName])*)?
    ('errors' errors+=[ErrorDecl:QualifiedName] (',' errors+=[ErrorDecl:QualifiedName])*)?;

// `A | B -> C | D`: a command in one of the source states ends in one of the target states. A factory
// (`create command`) has a single transition without sources: `-> Draft`.
Transition:
    (from+=[State:ID] ('|' from+=[State:ID])*)? '->' to+=[State:ID] ('|' to+=[State:ID])*;

Parameter:
    name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? label=STRING?;

// `persistent` marks an event whose contract is to be persisted (stored as a fact); events are not persisted by default.
EventDecl:
    (persistent?='persistent')? 'event' name=ID label=STRING? WithFieldSets? ('{' members+=Field* '}')?;

ErrorDecl:
    'error' name=ID label=STRING? WithFieldSets? ('{' members+=Field* '}')?;

TypeRef:
    primitive=PrimitiveType | decl=[TypeDecl:QualifiedName];

PrimitiveType returns string:
    'String' | 'Int' | 'Decimal' | 'Bool' | 'Timestamp' | 'UUID';

Multiplicity:
    optional?='?' | '[' lower=INT '..' (upper=INT | unbounded?='*') ']';

// Without an expression, an invariant is declared for documentation only: it needs a label or a `///` description (M018).
Invariant:
    'invariant' name=ID label=STRING? ('{' expr=Expression '}')?;

// ---- Invariant expressions ----

Expression:
    Implies;

Implies infers Expression:
    Or ({infer BinaryExpr.left=current} op='implies' right=Or)*;

Or infers Expression:
    And ({infer BinaryExpr.left=current} op='or' right=And)*;

And infers Expression:
    Comparison ({infer BinaryExpr.left=current} op='and' right=Comparison)*;

Comparison infers Expression:
    Unary (
        {infer BinaryExpr.left=current} op=('=='|'!='|'<='|'>='|'<'|'>') right=Unary
        | {infer RangeExpr.operand=current} 'in' lower=Unary '..' upper=Unary
    )?;

Unary infers Expression:
    {infer NotExpr} 'not' operand=Unary | Postfix;

Postfix infers Expression:
    Primary ({infer MemberAccess.receiver=current} '.' member=FeatureName)*;

Primary infers Expression:
    '(' Expression ')'
    | {infer CountExpr} 'count' '(' collection=Expression ')'
    | {infer ExistsExpr} 'exists' '(' operand=Expression ')'
    | {infer LengthExpr} 'length' '(' operand=Expression ')'
    | {infer MatchesExpr} 'matches' '(' operand=Expression ',' pattern=STRING ')'
    | {infer UniqueExpr} 'unique' '(' collection=Expression (',' param=LambdaParam '=>' keys+=Expression (',' keys+=Expression)*)? ')'
    | {infer ContainsExpr} 'contains' '(' collection=Expression ',' element=Expression ')'
    | {infer QuantifierExpr} quantifier=('all' | 'any') '(' collection=Expression ',' param=LambdaParam '=>' body=Expression ')'
    | {infer BoolLiteral} value=('true' | 'false')
    | {infer DecimalLiteral} negative?='-'? value=DECIMAL
    | {infer IntLiteral} negative?='-'? value=INT
    | {infer StringLiteral} value=STRING
    | {infer NameRef} name=FeatureName;

LambdaParam:
    name=FeatureName;

// Keywords that may also name fields; the functions of invariant expressions are told apart from names by their `(`.
FeatureName returns string:
    ID | 'id' | 'value' | 'by' | 'persistent' | 'fields' | 'with'
    | 'count' | 'exists' | 'length' | 'matches' | 'all' | 'any' | 'unique' | 'contains';

QualifiedName returns string:
    ID ('.' ID)*;

hidden terminal WS: /\s+/;
terminal DECIMAL returns string: /\d+\.\d+/;
terminal INT returns number: /\d+/;
terminal STRING: /"(\\.|[^"\\])*"/;
terminal ID: /[_a-zA-Z][\w_]*/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
