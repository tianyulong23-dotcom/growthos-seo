import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"
import type { ProjectOption } from "@/features/projects/project-options"

type ProjectOptionComboboxProps = {
  value: string
  onValueChange: (value: string) => void
  options: ProjectOption[]
  placeholder: string
  searchPlaceholder: string
  emptyText: string
  ariaLabel: string
}

export function ProjectOptionCombobox({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyText,
  ariaLabel,
}: ProjectOptionComboboxProps) {
  const [query, setQuery] = useState("")
  const selectedOption =
    options.find((option) => option.value === value) ?? null
  const hasQuery = Boolean(query.trim())
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()

    if (!normalizedQuery) {
      return options
    }

    return options.filter((option) =>
      option.searchText.toLocaleLowerCase().includes(normalizedQuery)
    )
  }, [options, query])
  const commonOptions = useMemo(
    () => options.filter((option) => option.isCommon),
    [options]
  )
  const otherOptions = useMemo(
    () => options.filter((option) => !option.isCommon),
    [options]
  )

  function renderOption(option: ProjectOption) {
    return (
      <ComboboxItem
        key={option.code}
        value={option}
        className="grid grid-cols-[minmax(0,1fr)_2.5rem] pr-8"
      >
        <span className="truncate">{option.label}</span>
        <span className="text-center font-mono text-xs font-normal text-muted-foreground">
          {option.code}
        </span>
      </ComboboxItem>
    )
  }

  return (
    <Combobox
      items={options}
      filteredItems={visibleOptions}
      value={selectedOption}
      onValueChange={(option) => {
        if (option) {
          onValueChange(option.value)
        }
      }}
      inputValue={query}
      onInputValueChange={(nextQuery, details) => {
        if (details.reason === "input-change") {
          setQuery(nextQuery)
        }
      }}
      onOpenChange={(open) => {
        if (!open) {
          setQuery("")
        }
      }}
      itemToStringLabel={(option) => option.label}
      itemToStringValue={(option) => option.value}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            type="button"
            variant="outline"
            className="w-full justify-between px-3 font-normal"
            aria-label={ariaLabel}
          />
        }
      >
        <span className="min-w-0 flex-1 truncate text-left">
          <ComboboxValue placeholder={placeholder} />
        </span>
      </ComboboxTrigger>
      <ComboboxContent
        className="min-w-(--anchor-width)"
        collisionAvoidance={{
          side: "none",
          align: "shift",
          fallbackAxisSide: "none",
        }}
        collisionPadding={12}
      >
        <ComboboxInput
          className="w-full"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          showTrigger={false}
        />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {hasQuery ? (
            <ComboboxCollection>
              {(option: ProjectOption) => renderOption(option)}
            </ComboboxCollection>
          ) : (
            <>
              <ComboboxGroup items={commonOptions}>
                <ComboboxLabel>主要</ComboboxLabel>
                <ComboboxCollection>
                  {(option: ProjectOption) => renderOption(option)}
                </ComboboxCollection>
              </ComboboxGroup>
              <ComboboxSeparator />
              <ComboboxGroup items={otherOptions}>
                <ComboboxLabel>其他</ComboboxLabel>
                <ComboboxCollection>
                  {(option: ProjectOption) => renderOption(option)}
                </ComboboxCollection>
              </ComboboxGroup>
            </>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
