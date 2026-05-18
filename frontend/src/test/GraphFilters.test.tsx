import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FILTERS, GraphFilters } from '../components/graph/GraphFilters'

describe('GraphFilters', () => {
  it('renders all four node-type toggles with counts', () => {
    render(
      <GraphFilters
        filters={DEFAULT_FILTERS}
        onChange={() => {}}
        counts={{ paper: 3, author: 5, category: 2, concept: 7 }}
      />
    )
    expect(screen.getByText(/Papers \(3\)/)).toBeTruthy()
    expect(screen.getByText(/Auteurs \(5\)/)).toBeTruthy()
    expect(screen.getByText(/Catégories \(2\)/)).toBeTruthy()
    expect(screen.getByText(/Concepts \(7\)/)).toBeTruthy()
  })

  it('toggling a checkbox calls onChange with the updated filter', () => {
    const onChange = vi.fn()
    render(<GraphFilters filters={DEFAULT_FILTERS} onChange={onChange} counts={{}} />)
    const paperCheckbox = screen.getByRole('checkbox', { name: /Papers/ })
    fireEvent.click(paperCheckbox)
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, paper: false })
  })

  it('moving the slider updates the semantic threshold', () => {
    const onChange = vi.fn()
    render(<GraphFilters filters={DEFAULT_FILTERS} onChange={onChange} counts={{}} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '0.85' } })
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, semanticThreshold: 0.85 })
  })

  it('picking the community colour mode calls onChange', () => {
    const onChange = vi.fn()
    render(<GraphFilters filters={DEFAULT_FILTERS} onChange={onChange} counts={{}} />)
    const communityRadio = screen.getByRole('radio', { name: /communauté/i })
    fireEvent.click(communityRadio)
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_FILTERS, colorBy: 'community' })
  })
})
