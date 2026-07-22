package screens

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// BudgetUsageClosedMsg is emitted when the budget-usage screen is dismissed.
type BudgetUsageClosedMsg struct{}

// BudgetUsageModel implements Phase 7's budget-usage.go panel — daily LLM
// call and Tier-2 apply usage against budget-tracker.mjs's caps.
type BudgetUsageModel struct {
	usage  data.BudgetUsage
	width  int
	height int
	theme  theme.Theme
}

// NewBudgetUsageModel creates the budget-usage screen.
func NewBudgetUsageModel(t theme.Theme, usage data.BudgetUsage, width, height int) BudgetUsageModel {
	return BudgetUsageModel{usage: usage, width: width, height: height, theme: t}
}

// Init implements tea.Model.
func (m BudgetUsageModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *BudgetUsageModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Update handles input for the budget-usage screen.
func (m BudgetUsageModel) Update(msg tea.Msg) (BudgetUsageModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return BudgetUsageClosedMsg{} }
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	}
	return m, nil
}

func (m BudgetUsageModel) renderBar(label string, count, cap int, color lipgloss.Color) string {
	labelStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Width(16)
	countStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)

	barMaxW := m.width - 40
	if barMaxW < 10 {
		barMaxW = 10
	}
	barW := 0
	if cap > 0 {
		barW = count * barMaxW / cap
		if barW > barMaxW {
			barW = barMaxW
		}
	}
	if barW < 1 && count > 0 {
		barW = 1
	}
	barColor := color
	if cap > 0 && count >= cap {
		barColor = m.theme.Red
	}
	bar := lipgloss.NewStyle().Foreground(barColor).Render(strings.Repeat("█", barW))

	return "  " + labelStyle.Render(label) + bar + " " + countStyle.Render(fmt.Sprintf("%d / %d", count, cap))
}

// View renders the budget-usage screen.
func (m BudgetUsageModel) View() string {
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	date := m.usage.Date
	if date == "" {
		date = "no usage recorded yet today"
	}
	header := titleStyle.Render("Budget Usage — " + date)

	lines := []string{
		"",
		m.renderBar("LLM calls", m.usage.LLMCalls, data.DefaultDailyLLMCalls, m.theme.Blue),
		"",
		m.renderBar("Tier2 LinkedIn", m.usage.Tier2Applies.LinkedIn, data.DefaultTier2DailyCap, m.theme.Green),
		m.renderBar("Tier2 Naukri", m.usage.Tier2Applies.Naukri, data.DefaultTier2DailyCap, m.theme.Green),
	}
	body := strings.Join(lines, "\n")

	help := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(0, 2).Render("q/esc back")

	return lipgloss.JoinVertical(lipgloss.Left, header, body, help)
}
