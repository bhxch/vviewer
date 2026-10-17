; https://pkg.go.dev/fmt#Printf
; https://pkg.go.dev/fmt#Sprintf
; https://pkg.go.dev/fmt#Scanf
; https://pkg.go.dev/fmt#Errorf
((call_expression
  function: (selector_expression
    operand: (identifier) @_module
    field: (field_identifier) @_func)
  arguments: (argument_list
    . (interpreted_string_literal) @injection.content))
  (#eq? @_module "fmt")
  (#any-of? @_func "Printf" "Sprintf" "Scanf" "Errorf")
  (#set! injection.language "go-format-string"))

; https://pkg.go.dev/fmt#Fprintf
; https://pkg.go.dev/fmt#Fscanf
; https://pkg.go.dev/fmt#Sscanf
((call_expression
  function: (selector_expression
    operand: (identifier) @_module
    field: (field_identifier) @_func)
  arguments: (argument_list
    (_)
    .
    (interpreted_string_literal) @injection.content))
  (#eq? @_module "fmt")
  (#any-of? @_func "Fprintf" "Fscanf" "Sscanf")
  (#set! injection.language "go-format-string"))

; https://pkg.go.dev/log#Printf
; https://pkg.go.dev/log#Fatalf
; https://pkg.go.dev/log#Panicf
; https://pkg.go.dev/log#Logger.Printf
; https://pkg.go.dev/log#Logger.Fatalf
; https://pkg.go.dev/log#Logger.Panicf
((call_expression
  function: (selector_expression
    operand: (identifier)
    field: (field_identifier) @_func)
  arguments: (argument_list
    . (interpreted_string_literal) @injection.content))
  (#any-of? @_func "Printf" "Fatalf" "Panicf")
  (#set! injection.language "go-format-string"))
