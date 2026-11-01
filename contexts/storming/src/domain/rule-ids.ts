/**
 * Storming's rule IDs: S001–S014 (the Event Storming DSL `.dtes`, ADR 0024) and SYNTAX for lexer/parser errors of
 * `.dtes` files. A diagnostic carries one as its code (the kernel's `RuleCode`).
 */
export type StormingRuleId =
    | 'SYNTAX'
    | 'S001'
    | 'S002'
    | 'S003'
    | 'S004'
    | 'S005'
    | 'S006'
    | 'S007'
    | 'S008'
    | 'S009'
    | 'S010'
    | 'S011'
    | 'S012'
    | 'S013'
    | 'S014';
