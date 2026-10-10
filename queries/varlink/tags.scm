(
  (comment)* @doc
  .
  (interface_declaration name: (_) @name) @definition.interface
  (#strip! @doc "^# ?")
  (#select-adjacent! @doc @definition.interface)
)
(
  (comment)* @doc
  .
  (typedef name: (_) @name) @definition.type
  (#strip! @doc "^# ?")
  (#select-adjacent! @doc @definition.type)
)
(
  (comment)* @doc
  .
  (error name: (_) @name) @definition.error
  (#strip! @doc "^# ?")
  (#select-adjacent! @doc @definition.error)
)
(
  (comment)* @doc
  .
  (method name: (_) @name) @definition.method
  (#strip! @doc "^# ?")
  (#select-adjacent! @doc @definition.method)
)
(typeref (name) @name) @reference.type
