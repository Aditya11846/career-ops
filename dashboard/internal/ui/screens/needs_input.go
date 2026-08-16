package screens

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// NeedsInputClosedMsg is emitted when the needs-input-queue screen is dismissed.
type NeedsInputClosedMsg struct{}

// NeedsInputModel implements the "needs your input" queue panel — Phase 7's
// needs-input-queue.go, following ProgressModel's Init/Update/View/Resize
// contract exactly.
type NeedsInputModel struct {
	entries      []data.NeedsInputEntry
	scrollOffset int
	width        int
	height       int
	theme        theme.Theme
}

// NewNeedsInputModel creates the needs-input-queue screen.
func NewNeedsInputModel(t theme.Theme, entries []data.NeedsInputEntry, width, height int) NeedsInputModel {
	return NeedsInputModel{entries: data.OpenNeedsInputEntries(entries), width: width, height: height, theme: t}
}

// Init implements tea.Model.
func (m NeedsInputModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *NeedsInputModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Update handles input for the needs-input-queue screen.
func (m NeedsInputModel) Update(msg tea.Msg) (NeedsInputModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return NeedsInputClosedMsg{} }
		case "down", "j":
			m.scrollOffset++
		case "up", "k":
			if m.scrollOffset > 0 {
				m.scrollOffset--
			}
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	}
	return m, nil
}

// View renders the needs-input-queue screen.
func (m NeedsInputModel) View() string {
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	header := titleStyle.Render("Needs Your Input")

	var lines []string
	if len(m.entries) == 0 {
		dim := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(0, 2)
		lines = append(lines, dim.Render("Nothing open — the queue is clear."))
	} else {
		sourceStyle := lipgloss.NewStyle().Foreground(m.theme.Yellow).Bold(true)
		companyStyle := lipgloss.NewStyle().Foreground(m.theme.Text).Bold(true)
		reasonStyle := lipgloss.NewStyle().Foreground(m.theme.Subtext)
		for _, e := range m.entries {
			company := e.Company
			if e.Role != "" {
				company += " — " + e.Role
			}
			lines = append(lines, "  "+sourceStyle.Render("["+e.Source+"]")+" "+companyStyle.Render(company))
			lines = append(lines, "    "+reasonStyle.Render(e.Reason))
			lines = append(lines, "")
		}
	}

	body := strings.Join(lines, "\n")
	bodyLines := strings.Split(body, "\n")
	offset := m.scrollOffset
	if offset >= len(bodyLines) {
		offset = len(bodyLines) - 1
	}
	if offset < 0 {
		offset = 0
	}
	if offset > 0 {
		bodyLines = bodyLines[offset:]
	}
	availHeight := m.height - 4
	if availHeight < 3 {
		availHeight = 3
	}
	if len(bodyLines) > availHeight {
		bodyLines = bodyLines[:availHeight]
	}
	body = strings.Join(bodyLines, "\n")

	help := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(0, 2).Render("j/k scroll · q/esc back")

	return lipgloss.JoinVertical(lipgloss.Left, header, body, help)
}
