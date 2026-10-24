; Comments

(line_comment) @comment
(block_comment) @comment
(doc_comment) @comment.doc

; Literals

(string) @string
(number) @number
(multiplicity (integer) @number)
(boolean) @boolean

; Declarations

(context name: (identifier) @module)
(id_declaration name: (identifier) @type)
(primitive_declaration name: (identifier) @type)
(verified_declaration name: (identifier) @type)
(enum_declaration name: (identifier) @type)
(value_declaration name: (identifier) @type)
(union_declaration name: (identifier) @type)
(entity_declaration name: (identifier) @type)
(aggregate_declaration name: (identifier) @type)
(event_declaration name: (identifier) @type)
(error_declaration name: (identifier) @type)
(field_set_declaration name: (identifier) @type)
(policy_declaration name: (identifier) @type)
(policy_declaration aggregate: (identifier) @type)

(enum_value name: (identifier) @constant)
(variant name: (identifier) @constant)
(state name: (identifier) @constant)
(transition from: (identifier) @constant)
(transition to: (identifier) @constant)
(outcome_pattern from: (identifier) @constant)
(outcome_pattern to: (identifier) @constant)

(command name: (identifier) @function)
(policy_declaration command: (identifier) @function)
(invariant name: (identifier) @label)
(requirement name: (identifier) @label)

; Fields and parameters

(field name: (identifier) @property)
(owns_field name: (identifier) @property)
(reference_field name: (identifier) @property)
(term_entry name: (identifier) @property)
(union_declaration discriminator: (identifier) @property)
(changes_clause field: (identifier) @property)
(parameter name: (identifier) @variable.parameter)
(lambda parameter: (identifier) @variable.parameter)

; Types and references

(primitive_type) @type.builtin
(qualified_name (identifier) @type)

; Expressions

(function_name) @function.builtin
(member_expression member: (identifier) @property)

; Keywords

[
  "shared"
  "context"
  "terms"
  "id"
  "primitive"
  "verified"
  "of"
  "for"
  "enum"
  "value"
  "fields"
  "with"
  "union"
  "by"
  "entity"
  "aggregate"
  "state"
  "owns"
  "references"
  "invariant"
  "create"
  "command"
  "requires"
  "else"
  "changes"
  "emits"
  "when"
  "errors"
  "persistent"
  "event"
  "error"
  "policy"
] @keyword

[
  "implies"
  "or"
  "and"
  "not"
  "in"
] @keyword.operator

; Operators and punctuation

[
  "=="
  "!="
  "<="
  ">="
  "<"
  ">"
  "->"
  "=>"
  "|"
  "-"
  ".."
  "?"
  "*"
] @operator

[
  "("
  ")"
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket

[
  ","
  ":"
  "."
] @punctuation.delimiter
