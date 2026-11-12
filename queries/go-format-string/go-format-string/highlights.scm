; https://github.com/helix-editor/helix/blob/master/runtime/queries/rust-format-args/highlights.scm

(escaped_percent_sign) @constant.character.escape

(explicit_argument_index) @constant.numeric

; (flag) @string.special.symbol
(flag) @constant.builtin

(text) @string

(width) @constant.numeric.integer
(precision) @constant.numeric.float
(asterisk) @string.special.symbol

(verb) @type

"." @punctuation.delimiter
"%" @punctuation.special

[
  "["
  "]"
] @punctuation.bracket
