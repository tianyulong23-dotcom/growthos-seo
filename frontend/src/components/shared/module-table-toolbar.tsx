import { Download, Filter, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export function ModuleTableToolbar({
  search,
  setSearch,
  filter,
  setFilter,
  options,
}: {
  search: string
  setSearch: (value: string) => void
  filter: string
  setFilter: (value: string) => void
  options: readonly string[]
}) {
  return (
    <div className="flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索当前列表..."
          className="w-full pl-9 sm:max-w-sm"
        />
      </div>
      <Select
        value={filter}
        onValueChange={(value) => setFilter(value ?? "全部")}
      >
        <SelectTrigger className="w-full sm:w-36">
          <Filter className="text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm">
        <Download />
        导出
      </Button>
    </div>
  )
}
