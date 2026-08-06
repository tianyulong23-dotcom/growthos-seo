import * as React from "react"
import { QueryClientProvider } from "@tanstack/react-query"

import { keywordQueryClient } from "@/features/keywords/keyword-query-client"

export function KeywordQueryProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <QueryClientProvider client={keywordQueryClient}>
      {children}
    </QueryClientProvider>
  )
}
