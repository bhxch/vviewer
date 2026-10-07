((html_text) @injection.content
  (#set! injection.language "html")
  (#set! injection.include-children)
  (#set! injection.combined))

((rust_text) @injection.content
   (#set! injection.language "rust")
   (#set! injection.include-children))

((comment_block) @injection.content
  (#set! injection.language "comment"))

(if_stmt ((rust_text) @injection.content .
    (open_brace) @injection.content
		(close_brace) @injection.content .
    (else_clause (rust_text) @injection.content
    ((open_brace) @injection.content
    (close_brace) @injection.content)?)?)
    (#set! injection.language "rust")
    ; (#set! injection.include-children)
    ; (#set! injection.combined)
    )

; (if_stmt [(rust_text)(open_brace)(close_brace)(else_clause (rust_text))] @injection.content
; (#set! injection.language "rust"))

; (if_stmt
;   [
;     (rust_text)
;     (open_brace)
;     (close_brace)
;     (else_clause (rust_text))?
;   ] @injection.content
;   (#set! injection.language "rust")
;   ; (#set! injection.include-children)
;   (#set! injection.combined))

; ((if_stmt
;   head: (rust_text)
;   . (open_brace)
;   . (close_brace)
;   . (else_clause
;        head: (rust_text))) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children)
;   ; (#set! injection.combined)
;   )

; ((source_file) @injection.content
;   ; (#not-match? @injection.content "comment_block")
;   (#set! injection.language "html")
;   (#set! injection.include-children)
;   (#set! injection.combined))

; ((html_text) @injection.content
;   (#set! injection.language "html")
;   (#set! injection.include-children)
;   (#set! injection.combined))
  
; ((html_inner_text) @injection.content
;   (#set! injection.language "html")
;   (#set! injection.include-children)
;   (#set! injection.combined))
 
; (rust_expr_simple
;   expr: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (rust_expr_paren
;   expr: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (if_stmt
;   head: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))
; (else_clause
;   head: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (for_stmt
;   head: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (while_stmt
;   head: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (match_stmt
;   head: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))
; (match_stmt_arm
;   pattern: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))

; (match_text
;   text: (source_text) @injection.content
;   (#set! injection.language "html")
;   (#set! injection.include-children))

; (raw_block
;   content: (source_text) @injection.content
;   (#set! injection.language "html")
;   (#set! injection.include-children))

; (rust_block
;   content: (source_text) @injection.content
;   (#set! injection.language "rust")
;   (#set! injection.include-children))
