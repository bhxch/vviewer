; Concerto Language - Text Object Queries
; =========================================
; Dual-capture pattern for cross-editor compatibility:
;   Neovim (nvim-treesitter-textobjects): @class.outer / @class.inner
;   Helix:                                @class.around / @class.inside
;
; Both sets of captures coexist on the same nodes. Each editor reads
; only the names it recognises and ignores the rest.
; ---------------------------------------------------------------------------
; Classes / declarations
; ---------------------------------------------------------------------------
; Neovim: vac / vic — select whole declaration / body contents
; Helix:  ]c / [c — jump next/prev class, mac / mic — select around/inside
(concept_declaration
  (class_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(asset_declaration
  (class_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(participant_declaration
  (class_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(transaction_declaration
  (class_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(event_declaration
  (class_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(enum_declaration
  (enum_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

(map_declaration
  (map_body
    .
    "{"
    _+ @class.inner @class.inside
    "}")) @class.outer @class.around

; Scalar declarations have no body braces — outer/around only
(scalar_declaration) @class.outer @class.around

; ---------------------------------------------------------------------------
; Block (Neovim only — Helix has no @block capture)
; ---------------------------------------------------------------------------
; vab / vib — select whole block / block contents (excluding braces)
(class_body
  .
  "{"
  _+ @block.inner
  "}") @block.outer

(enum_body
  .
  "{"
  _+ @block.inner
  "}") @block.outer

(map_body
  .
  "{"
  _+ @block.inner
  "}") @block.outer

; ---------------------------------------------------------------------------
; Comments
; ---------------------------------------------------------------------------
; Neovim: @comment.outer
; Helix:  @comment.around / @comment.inside, ]C / [C for navigation
(line_comment) @comment.outer @comment.inside

(block_comment) @comment.outer @comment.inside

(line_comment) @comment.around

(block_comment) @comment.around

; ---------------------------------------------------------------------------
; Parameters — fields, enum values, map entries
; ---------------------------------------------------------------------------
; Neovim: @parameter.inner — dap / vip
; Helix:  @parameter.inside — ]a / [a for navigation, mia / maa to select
(string_field) @parameter.inner @parameter.inside

(boolean_field) @parameter.inner @parameter.inside

(datetime_field) @parameter.inner @parameter.inside

(integer_field) @parameter.inner @parameter.inside

(long_field) @parameter.inner @parameter.inside

(double_field) @parameter.inner @parameter.inside

(object_field) @parameter.inner @parameter.inside

(relationship_field) @parameter.inner @parameter.inside

(enum_property) @parameter.inner @parameter.inside

(map_key_type) @parameter.inner @parameter.inside

(map_value_type) @parameter.inner @parameter.inside

; ---------------------------------------------------------------------------
; Assignment (Neovim only — Helix has no @assignment capture)
; ---------------------------------------------------------------------------
; daa / via — operate on default value clauses
(string_default
  "="
  (_) @assignment.inner) @assignment.outer

(boolean_default
  "="
  (_) @assignment.inner) @assignment.outer

(integer_default
  "="
  (_) @assignment.inner) @assignment.outer

(real_default
  "="
  (_) @assignment.inner) @assignment.outer
