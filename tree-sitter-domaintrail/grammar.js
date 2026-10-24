/**
 * Tree-sitter grammar of the DomainTrail DSL (`.dt` files), for highlighting and editor structure.
 *
 * It follows src/language/domain.langium, which stays the definition of the language; test/tree-sitter.test.ts
 * parses the shop example and the guide's examples with both. Where Langium decides with more lookahead (a field
 * after a command, a keyword used as a field name), the conflicts below let the parser try both.
 *
 * @file DomainTrail grammar for tree-sitter
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

const PREC = {
  implies: 1,
  or: 2,
  and: 3,
  comparison: 4,
  not: 5,
  member: 6,
};

/** Keywords that may also name fields, parameters and lambda parameters (FeatureName). */
const FEATURE_KEYWORDS = [
  'id', 'value', 'by', 'persistent', 'fields', 'with', 'requires', 'else', 'when', 'changes', 'verified', 'of', 'for', 'policy',
  'count', 'exists', 'length', 'matches', 'all', 'any', 'unique', 'contains',
];

const commaSep1 = (rule) => seq(rule, repeat(seq(',', rule)));
const pipeSep1 = (rule) => seq(rule, repeat(seq('|', rule)));

module.exports = grammar({
  name: 'domaintrail',

  word: ($) => $.identifier,

  extras: ($) => [/\s/, $.doc_comment, $.line_comment, $.block_comment],

  conflicts: ($) => [
    [$.command],
    [$.emit],
    [$.outcome_pattern],
  ],

  rules: {
    source_file: ($) => repeat($.context),

    // ---- Contexts ----

    context: ($) => seq(
      optional('shared'),
      'context',
      field('name', $.identifier),
      optional(field('label', $.string)),
      '{',
      repeat(choice($._context_element, $.terms)),
      '}',
    ),

    terms: ($) => seq('terms', '{', repeat($.term_entry), '}'),

    term_entry: ($) => seq(field('name', $._feature_name), ':', field('label', $.string)),

    _context_element: ($) => choice(
      $.id_declaration,
      $.primitive_declaration,
      $.verified_declaration,
      $.enum_declaration,
      $.value_declaration,
      $.union_declaration,
      $.entity_declaration,
      $.aggregate_declaration,
      $.event_declaration,
      $.error_declaration,
      $.field_set_declaration,
      $.policy_declaration,
    ),

    // ---- Types ----

    id_declaration: ($) => seq('id', $._primitive_head),

    primitive_declaration: ($) => seq('primitive', $._primitive_head),

    _primitive_head: ($) => seq(
      field('name', $.identifier),
      optional(field('label', $.string)),
      ':',
      field('base', $.primitive_type),
      optional(field('body', $.primitive_body)),
    ),

    // Either named invariants, or a single anonymous constraint: `{ value > 0 }`.
    primitive_body: ($) => seq('{', choice(repeat1($.invariant), field('constraint', $._expression)), '}'),

    // Evidence that a check outside the aggregate was made (ADR 0023).
    verified_declaration: ($) => seq(
      'verified',
      field('name', $.identifier),
      optional(field('label', $.string)),
      'of',
      field('base', $._type),
      optional(seq('for', field('context', $._type), optional('?'))),
      optional($.errors_clause),
    ),

    enum_declaration: ($) => seq(
      'enum',
      field('name', $.identifier),
      optional(field('label', $.string)),
      '{',
      optional(seq($.enum_value, repeat(seq(optional(','), $.enum_value)))),
      '}',
    ),

    enum_value: ($) => seq(field('name', $.identifier), optional(field('label', $.string))),

    value_declaration: ($) => seq(
      'value',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      optional(field('body', $.member_block)),
    ),

    field_set_declaration: ($) => seq(
      'fields',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      field('body', $.member_block),
    ),

    with_clause: ($) => seq('with', commaSep1(field('field_set', $.qualified_name))),

    union_declaration: ($) => seq(
      'union',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional(seq(
        'by',
        field('discriminator', $._feature_name),
        optional(seq(':', field('tag_type', $.qualified_name))),
      )),
      '{',
      repeat($.variant),
      '}',
    ),

    variant: ($) => seq(
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional(field('body', $.member_block)),
    ),

    entity_declaration: ($) => seq(
      'entity',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      field('body', $.member_block),
    ),

    aggregate_declaration: ($) => seq(
      'aggregate',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      field('body', $.aggregate_body),
    ),

    aggregate_body: ($) => seq('{', repeat(choice($._data_member, $.state, $.command)), '}'),

    member_block: ($) => seq('{', repeat($._data_member), '}'),

    _data_member: ($) => choice($.field, $.owns_field, $.reference_field, $.invariant),

    state: ($) => seq(
      'state',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional(field('body', $.member_block)),
    ),

    // ---- Fields ----

    field: ($) => seq($._field_head, optional(field('label', $.string))),

    owns_field: ($) => seq('owns', $._field_head, optional(field('label', $.string))),

    reference_field: ($) => seq(
      'references',
      $._field_head,
      '->',
      field('target', $.qualified_name),
      optional(field('label', $.string)),
    ),

    _field_head: ($) => seq(
      field('name', $._feature_name),
      ':',
      field('type', $._type),
      optional(field('multiplicity', $.multiplicity)),
    ),

    _type: ($) => choice($.primitive_type, $.qualified_name),

    primitive_type: (_) => choice('String', 'Int', 'Decimal', 'Bool', 'Timestamp', 'UUID'),

    multiplicity: ($) => choice(
      '?',
      seq('[', field('lower', $.integer), '..', choice(field('upper', $.integer), '*'), ']'),
    ),

    // ---- Commands ----

    command: ($) => seq(
      optional('create'),
      'command',
      field('name', $._feature_name),
      $.parameters,
      optional(field('label', $.string)),
      optional(seq($.transition, repeat(seq(optional(','), $.transition)))),
      repeat($.requirement),
      optional($.changes_clause),
      optional($.emits_clause),
      optional($.errors_clause),
    ),

    parameters: ($) => seq('(', optional(commaSep1($.parameter)), ')'),

    parameter: ($) => seq($._field_head, optional(field('label', $.string))),

    // `A | B -> C | D`; a factory has no sources: `-> Draft`.
    transition: ($) => seq(
      optional(pipeSep1(field('from', $.identifier))),
      '->',
      pipeSep1(field('to', $.identifier)),
    ),

    requirement: ($) => seq(
      'requires',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional(seq('{', field('condition', $._expression), '}')),
      'else',
      field('error', $.qualified_name),
    ),

    changes_clause: ($) => seq('changes', commaSep1(field('field', $._feature_name))),

    emits_clause: ($) => seq('emits', commaSep1($.emit)),

    emit: ($) => seq(
      field('event', $.qualified_name),
      optional(field('multiplicity', $.multiplicity)),
      optional(seq('when', field('when', $.outcome_pattern))),
    ),

    outcome_pattern: ($) => seq(
      optional(pipeSep1(field('from', $.identifier))),
      '->',
      optional(pipeSep1(field('to', $.identifier))),
    ),

    errors_clause: ($) => seq('errors', commaSep1(field('error', $.qualified_name))),

    // ---- Policies ----

    // `policy Name "label" when Event -> Aggregate.command`
    policy_declaration: ($) => seq(
      'policy',
      field('name', $.identifier),
      optional(field('label', $.string)),
      'when',
      field('event', $.qualified_name),
      '->',
      field('aggregate', $.identifier),
      '.',
      field('command', $._feature_name),
    ),

    // ---- Events and errors ----

    event_declaration: ($) => seq(
      optional('persistent'),
      'event',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      optional(field('body', $.field_block)),
    ),

    error_declaration: ($) => seq(
      'error',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional($.with_clause),
      optional(field('body', $.field_block)),
    ),

    field_block: ($) => seq('{', repeat($.field), '}'),

    invariant: ($) => seq(
      'invariant',
      field('name', $.identifier),
      optional(field('label', $.string)),
      optional(seq('{', field('condition', $._expression), '}')),
    ),

    // ---- Expressions ----

    _expression: ($) => choice(
      $.binary_expression,
      $.range_expression,
      $.not_expression,
      $.member_expression,
      $.parenthesized_expression,
      $.call_expression,
      $.boolean,
      $.number,
      $.string,
      $._feature_name,
    ),

    binary_expression: ($) => choice(
      prec.left(PREC.implies, seq(field('left', $._expression), field('operator', 'implies'), field('right', $._expression))),
      prec.left(PREC.or, seq(field('left', $._expression), field('operator', 'or'), field('right', $._expression))),
      prec.left(PREC.and, seq(field('left', $._expression), field('operator', 'and'), field('right', $._expression))),
      prec.left(PREC.comparison, seq(
        field('left', $._expression),
        field('operator', choice('==', '!=', '<=', '>=', '<', '>')),
        field('right', $._expression),
      )),
    ),

    range_expression: ($) => prec.left(PREC.comparison, seq(
      field('operand', $._expression),
      'in',
      field('lower', $._expression),
      '..',
      field('upper', $._expression),
    )),

    not_expression: ($) => prec(PREC.not, seq('not', field('operand', $._expression))),

    member_expression: ($) => prec(PREC.member, seq(field('object', $._expression), '.', field('member', $._feature_name))),

    parenthesized_expression: ($) => seq('(', $._expression, ')'),

    call_expression: ($) => choice(
      seq(field('function', $._unary_function), '(', field('argument', $._expression), ')'),
      seq(field('function', alias('matches', $.function_name)), '(', field('argument', $._expression), ',', field('pattern', $.string), ')'),
      seq(field('function', alias('contains', $.function_name)), '(', field('argument', $._expression), ',', field('element', $._expression), ')'),
      seq(
        field('function', alias('unique', $.function_name)),
        '(',
        field('argument', $._expression),
        optional(seq(',', field('key', $.lambda), repeat(seq(',', field('key', $._expression))))),
        ')',
      ),
      seq(field('function', $._quantifier), '(', field('argument', $._expression), ',', field('predicate', $.lambda), ')'),
    ),

    _unary_function: ($) => alias(choice('count', 'exists', 'length'), $.function_name),

    _quantifier: ($) => alias(choice('all', 'any'), $.function_name),

    lambda: ($) => seq(field('parameter', $._feature_name), '=>', field('body', $._expression)),

    boolean: (_) => choice('true', 'false'),

    number: ($) => seq(optional('-'), choice($.decimal, $.integer)),

    // ---- Names and tokens ----

    _feature_name: ($) => choice($.identifier, alias(choice(...FEATURE_KEYWORDS), $.identifier)),

    qualified_name: ($) => seq($.identifier, repeat(seq('.', $.identifier))),

    identifier: (_) => /[_a-zA-Z][\w_]*/,

    string: (_) => /"(\\.|[^"\\])*"/,

    decimal: (_) => /\d+\.\d+/,

    integer: (_) => /\d+/,

    doc_comment: (_) => token(prec(1, seq('///', /[^\n\r]*/))),

    line_comment: (_) => token(seq('//', /[^\n\r]*/)),

    block_comment: (_) => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});
