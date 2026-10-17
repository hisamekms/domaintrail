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
    IdType | PrimitiveDecl | EnumDecl | ValueObject | Entity | Aggregate | EventDecl | ErrorDecl;

// Types that may appear on the right-hand side of a field declaration.
type TypeDecl = IdType | PrimitiveDecl | EnumDecl | ValueObject | Entity | Aggregate;

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
    'value' name=ID label=STRING? ('{' members+=DataMember* '}')?;

Entity:
    'entity' name=ID label=STRING? '{' members+=DataMember* '}';

Aggregate:
    'aggregate' name=ID label=STRING? '{' members+=AggregateMember* '}';

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
    ('from' from+=[State:ID] ('|' from+=[State:ID])*)?
    ('to' to+=[State:ID] ('|' to+=[State:ID])*)?
    ('emits' emits+=[EventDecl:QualifiedName] (',' emits+=[EventDecl:QualifiedName])*)?
    ('errors' errors+=[ErrorDecl:QualifiedName] (',' errors+=[ErrorDecl:QualifiedName])*)?;

Parameter:
    name=FeatureName ':' type=TypeRef multiplicity=Multiplicity? label=STRING?;

EventDecl:
    'event' name=ID label=STRING? ('{' members+=Field* '}')?;

ErrorDecl:
    'error' name=ID label=STRING? ('{' members+=Field* '}')?;

TypeRef:
    primitive=PrimitiveType | decl=[TypeDecl:QualifiedName];

PrimitiveType returns string:
    'String' | 'Int' | 'Decimal' | 'Bool' | 'Timestamp' | 'UUID';

Multiplicity:
    optional?='?' | '[' lower=INT '..' (upper=INT | unbounded?='*') ']';

Invariant:
    'invariant' name=ID label=STRING? '{' expr=Expression '}';

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
    | {infer QuantifierExpr} quantifier=('all' | 'any') '(' collection=Expression ',' param=LambdaParam '=>' body=Expression ')'
    | {infer BoolLiteral} value=('true' | 'false')
    | {infer DecimalLiteral} negative?='-'? value=DECIMAL
    | {infer IntLiteral} negative?='-'? value=INT
    | {infer StringLiteral} value=STRING
    | {infer NameRef} name=FeatureName;

LambdaParam:
    name=FeatureName;

FeatureName returns string:
    ID | 'id' | 'value';

QualifiedName returns string:
    ID ('.' ID)*;

hidden terminal WS: /\s+/;
terminal DECIMAL returns string: /\d+\.\d+/;
terminal INT returns number: /\d+/;
terminal STRING: /"(\\.|[^"\\])*"/;
terminal ID: /[_a-zA-Z][\w_]*/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
