/**
 * Modeling's rule IDs: the rules from the spec (M001–M012), plus M013 (identity field), M014 (shared contexts), M015
 * (unions), M016 (field sets), M017 (events carry the ID of their aggregate), M018 (invariants and requirements without
 * an expression), M019 (parameters named like fields their command's requirements see), M020 (factories take the new
 * aggregate's ID as a parameter), M021 (the fields a command `changes`), M022 (event and error fields named after their
 * source), M023 (policies), M024 (verified types), L001–L003 (Japanese names), and SYNTAX for lexer/parser errors of
 * `.dt` files. M011 (the generated TypeScript names) is reported by the generator's check, which the project analysis
 * runs. A diagnostic carries one as its code (the kernel's `RuleCode`).
 */
export type ModelingRuleId =
    | 'SYNTAX'
    | 'M001'
    | 'M002'
    | 'M003'
    | 'M004'
    | 'M005'
    | 'M006'
    | 'M007'
    | 'M008'
    | 'M009'
    | 'M010'
    | 'M011'
    | 'M012'
    | 'M013'
    | 'M014'
    | 'M015'
    | 'M016'
    | 'M017'
    | 'M018'
    | 'M019'
    | 'M020'
    | 'M021'
    | 'M022'
    | 'M023'
    | 'M024'
    | 'L001'
    | 'L002'
    | 'L003';
