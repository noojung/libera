import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { createPortal } from 'react-dom'
import './Select.css'

export type SelectValue = string | number

export interface SelectOption<T extends SelectValue> {
  value: T
  label: string
  disabled?: boolean
}

export interface SelectProps<T extends SelectValue> {
  value: T
  options: readonly SelectOption<T>[]
  onChange: (value: T) => void
  ariaLabel: string
  id?: string
  className?: string
  rootClassName?: string
  disabled?: boolean
  /** Shows the placeholder in place of the selected label, for a control whose value does not apply right now. */
  cleared?: boolean
  placeholder?: string
  title?: string
}

interface MenuPosition {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

const VIEWPORT_MARGIN = 8
const MENU_GAP = 6
const MAX_MENU_HEIGHT = 240

export function Select<T extends SelectValue>({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  className = '',
  rootClassName = '',
  disabled = false,
  cleared = false,
  placeholder = '',
  title
}: SelectProps<T>) {
  const generatedId = useId()
  const triggerId = id ?? `select-trigger-${generatedId}`
  const listboxId = `select-listbox-${generatedId}`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)

  const selectedIndex = options.findIndex(option => option.value === value)
  const selectedOption = options[selectedIndex]

  const firstEnabledIndex = () => options.findIndex(option => !option.disabled)
  const lastEnabledIndex = () => {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index].disabled) return index
    }
    return -1
  }

  const adjacentEnabledIndex = (from: number, direction: 1 | -1) => {
    if (options.length === 0) return -1
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length) % options.length
      if (!options[index].disabled) return index
    }
    return -1
  }

  const openMenu = (index = selectedIndex >= 0 ? selectedIndex : firstEnabledIndex()) => {
    if (disabled || options.length === 0) return
    setActiveIndex(index)
    setOpen(true)
  }

  const closeMenu = () => {
    setOpen(false)
    typeaheadRef.current = ''
  }

  const selectIndex = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.value)
    closeMenu()
    triggerRef.current?.focus()
  }

  const updateMenuPosition = () => {
    const trigger = triggerRef.current
    if (!trigger) return

    const rect = trigger.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const menuHeight = Math.min(menuRef.current?.scrollHeight ?? MAX_MENU_HEIGHT, MAX_MENU_HEIGHT)
    const spaceBelow = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_MARGIN
    const spaceAbove = rect.top - MENU_GAP - VIEWPORT_MARGIN
    const openAbove = spaceBelow < menuHeight && spaceAbove > spaceBelow
    const availableHeight = openAbove ? spaceAbove : spaceBelow
    const naturalMenuWidth = menuRef.current?.scrollWidth ?? rect.width
    const width = Math.min(
      Math.max(rect.width, naturalMenuWidth),
      viewportWidth - VIEWPORT_MARGIN * 2
    )
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left),
      Math.max(VIEWPORT_MARGIN, viewportWidth - width - VIEWPORT_MARGIN)
    )

    setMenuPosition({
      ...(openAbove
        ? { bottom: viewportHeight - rect.top + MENU_GAP }
        : { top: rect.bottom + MENU_GAP }),
      left,
      width,
      maxHeight: Math.max(72, Math.min(MAX_MENU_HEIGHT, availableHeight))
    })
  }

  useLayoutEffect(() => {
    if (!open) return
    updateMenuPosition()
  }, [open, options.length])

  useEffect(() => {
    if (!open) return

    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu()
    }
    const handleViewportChange = () => updateMenuPosition()

    document.addEventListener('pointerdown', handleOutsidePointer)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointer)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || activeIndex < 0) return
    const activeOption = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`)
    activeOption?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex, open])

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
  }, [])

  const handleTypeahead = (key: string) => {
    typeaheadRef.current += key.toLocaleLowerCase()
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current)
    typeaheadTimerRef.current = window.setTimeout(() => {
      typeaheadRef.current = ''
      typeaheadTimerRef.current = null
    }, 500)

    const start = activeIndex >= 0 ? activeIndex : selectedIndex
    const orderedIndices = options.map((_, index) => (start + index + 1 + options.length) % options.length)
    const match = orderedIndices.find(index => (
      !options[index].disabled
      && options[index].label.toLocaleLowerCase().startsWith(typeaheadRef.current)
    ))
    if (match === undefined) return
    if (!open) openMenu(match)
    else setActiveIndex(match)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.length === 1 && event.key !== ' ') {
      event.preventDefault()
      handleTypeahead(event.key)
      return
    }

    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        openMenu()
      }
      return
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex(current => adjacentEnabledIndex(current, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex(current => adjacentEnabledIndex(current, -1))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(firstEnabledIndex())
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(lastEnabledIndex())
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        selectIndex(activeIndex)
        break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        closeMenu()
        break
      case 'Tab':
        closeMenu()
        break
    }
  }

  const menu = open && createPortal(
    <div
      ref={menuRef}
      id={listboxId}
      className="select__menu"
      role="listbox"
      aria-label={ariaLabel}
      /* eslint-disable-next-line no-restricted-syntax -- portal collision coordinates are calculated from the trigger at runtime. */
      style={menuPosition ?? { visibility: 'hidden' }}
    >
      {options.map((option, index) => (
        <div
          key={String(option.value)}
          id={`${listboxId}-option-${index}`}
          className={`select__option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}${option.disabled ? ' is-disabled' : ''}`}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          data-option-index={index}
          onPointerMove={() => {
            if (!option.disabled) setActiveIndex(index)
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => selectIndex(index)}
        >
          <span className="select__option-label">{option.label}</span>
          {option.value === value && <Check className="select__check" size={15} aria-hidden="true" />}
        </div>
      ))}
    </div>,
    document.body
  )

  return (
    <div className={`select${rootClassName ? ` ${rootClassName}` : ''}`}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`select__trigger${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
        disabled={disabled}
        title={title}
        onClick={() => {
          if (open) closeMenu()
          else openMenu()
        }}
        onKeyDown={handleKeyDown}
      >
        <span className={`select__value${cleared ? ' select__value--placeholder' : ''}`}>
          {cleared ? placeholder : selectedOption?.label ?? ''}
        </span>
        <ChevronDown className="select__chevron" size={16} aria-hidden="true" />
      </button>
      {menu}
    </div>
  )
}
