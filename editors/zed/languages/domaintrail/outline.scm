; Contexts and their declarations, aggregates with their states and commands, as Zed's outline and breadcrumbs.

(doc_comment) @annotation

(context
  "shared"? @context
  "context" @context
  name: (_) @name) @item

(id_declaration "id" @context name: (_) @name) @item
(primitive_declaration "primitive" @context name: (_) @name) @item
(verified_declaration "verified" @context name: (_) @name) @item
(enum_declaration "enum" @context name: (_) @name) @item
(value_declaration "value" @context name: (_) @name) @item
(union_declaration "union" @context name: (_) @name) @item
(field_set_declaration "fields" @context name: (_) @name) @item
(entity_declaration "entity" @context name: (_) @name) @item
(aggregate_declaration "aggregate" @context name: (_) @name) @item
(event_declaration "persistent"? @context "event" @context name: (_) @name) @item
(error_declaration "error" @context name: (_) @name) @item
(policy_declaration "policy" @context name: (_) @name) @item
(terms "terms" @name) @item

(state "state" @context name: (_) @name) @item
(command "create"? @context "command" @context name: (_) @name) @item
(invariant "invariant" @context name: (_) @name) @item
(variant name: (_) @name) @item
