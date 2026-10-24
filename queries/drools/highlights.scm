; ============================================================
; COMMENTS
; ============================================================

(comment) @comment

; ============================================================
; TOP-LEVEL KEYWORDS
; ============================================================

[
  "package"
  "unit"
  "import"
  "global"
  "declare"
  "rule"
  "query"
  "function"
  "end"
] @keyword

; ============================================================
; RULE STRUCTURE
; ============================================================

[
  "when"
  "then"
] @keyword.control

; ============================================================
; LHS KEYWORDS
; ============================================================

[
  "and"
  "or"
  "not"
  "exists"
  "eval"
  "forall"
  "accumulate"
  "acc"
  "groupby"
  "from"
  "collect"
  "over"
  "window"
  "entry-point"
] @keyword

; ============================================================
; DROOLS RHS ACTIONS
; ============================================================

[
  "insert"
  "insertLogical"
  "update"
  "modify"
  "delete"
  "retract"
] @function.builtin

; ============================================================
; CONTROL FLOW (in RHS / function bodies)
; ============================================================

[
  "if"
  "else"
  "for"
  "while"
  "return"
  "do"
  "break"
] @keyword.control

; ============================================================
; DECLARE SUB-KEYWORDS
; ============================================================

[
  "trait"
  "type"
  "enum"
  "extends"
  "static"
] @keyword

; ============================================================
; ATTRIBUTE NAMES
; ============================================================

[
  "salience"
  "enabled"
  "no-loop"
  "auto-focus"
  "lock-on-active"
  "refract"
  "direct"
  "activation-group"
  "ruleflow-group"
  "date-effective"
  "date-expires"
  "dialect"
  "calendars"
  "timer"
  "duration"
  "attributes"
] @attribute

; ============================================================
; DROOLS-SPECIFIC OPERATORS
; ============================================================

[
  "matches"
  "memberOf"
  "contains"
  "excludes"
  "soundslike"
  "str"
  "after"
  "before"
  "coincides"
  "during"
  "includes"
  "finishes"
  "finishedby"
  "meets"
  "metby"
  "overlaps"
  "overlappedby"
  "starts"
  "startedby"
  "instanceof"
] @keyword.operator

; ============================================================
; TYPE KEYWORDS
; ============================================================

[
  "byte"
  "short"
  "int"
  "long"
  "float"
  "double"
  "boolean"
  "char"
  "void"
] @type.builtin

; ============================================================
; LITERALS
; ============================================================

(string_literal) @string
(number) @number
(boolean_literal) @boolean
(null_literal) @constant.builtin
(time_interval) @number.special

; ============================================================
; "this" / "super" / "new"
; ============================================================

["this" "super"] @variable.builtin
"new" @keyword

; ============================================================
; ANNOTATIONS
; ============================================================

(annotation "@" @punctuation.special)
(annotation (qualified_name) @attribute)

; ============================================================
; RULE / QUERY / FUNCTION NAMES
; ============================================================

(rule_decl "rule" . (string_literal) @string.special)
(rule_decl "rule" . (identifier) @string.special)
(query_decl "query" . (string_literal) @string.special)
(query_decl "query" . (identifier) @string.special)
(function_decl "function" . _ . (identifier) @function)

; ============================================================
; PATTERN BINDING LABELS  ($p :)
; ============================================================

(label (identifier) @variable.parameter)
(unif  (identifier) @variable.parameter)

; ============================================================
; TYPES
; ============================================================

(lhs_pattern (qualified_name) @type)
(type (qualified_type (qualified_name (identifier) @type)))

; ============================================================
; FIELD / TYPE DECLARATIONS
; ============================================================

(type_declaration name: (qualified_name) @type.definition)
(field_decl name: (identifier) @variable.member)
(enum_declaration (qualified_name) @type.definition)
(enumerative (identifier) @constant)

; ============================================================
; METHOD CALLS
; ============================================================

(method_call method: (identifier) @function.method)

; ============================================================
; FIELD ACCESS
; ============================================================

(field_access (identifier) @variable.member)

; ============================================================
; OPERATORS
; ============================================================

[
  "=" "+=" "-=" "*=" "/=" "&=" "|=" "^=" "%=" "<<=" ">>=" ">>>="
  "==" "!=" "<" ">" "<=" ">="
  "+" "-" "*" "/" "%"
  "&&" "||" "!"
  "&" "|" "^" "~" "<<" ">>" ">>>"
  "++" "--"
  "?" ":"
] @operator

; ============================================================
; PUNCTUATION
; ============================================================

["(" ")" "[" "]" "{" "}"] @punctuation.bracket
["." "," ";" "?."] @punctuation.delimiter
