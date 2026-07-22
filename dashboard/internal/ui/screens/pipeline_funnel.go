package screens

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/theme"
)

// PipelineFunnelClosedMsg is emitted when the pipeline-funnel screen is dismissed.
type PipelineFunnelClosedMsg struct{}

// PipelineFunnelModel implements Phase 7's pipeline-funnel.go panel — the
// broader scanned->scored->applied->interview funnel (adds "scanned" from
// scan-history.tsv, upstream of the tracker-only funnel ProgressModel shows).
type PipelineFunnelModel struct {
	stages []data.PipelineFunnelStage
	width  int
	height int
	theme  theme.Theme
}

// NewPipelineFunnelModel creates the pipeline-funnel screen.
func NewPipelineFunnelModel(t theme.Theme, stages []data.PipelineFunnelStage, width, height int) PipelineFunnelModel {
	return PipelineFunnelModel{stages: stages, width: width, height: height, theme: t}
}

// Init implements tea.Model.
func (m PipelineFunnelModel) Init() tea.Cmd { return nil }

// Resize updates dimensions.
func (m *PipelineFunnelModel) Resize(width, height int) {
	m.width = width
	m.height = height
}

// Update handles input for the pipeline-funnel screen.
func (m PipelineFunnelModel) Update(msg tea.Msg) (PipelineFunnelModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "esc":
			return m, func() tea.Msg { return PipelineFunnelClosedMsg{} }
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	}
	return m, nil
}

// View renders the pipeline-funnel screen.
func (m PipelineFunnelModel) View() string {
	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(m.theme.Mauve).Background(m.theme.Surface).Width(m.width).Padding(0, 2)
	header := titleStyle.Render("Pipeline Funnel")

	maxCount := 0
	for _, s := range m.stages {
		if s.Count > maxCount {
			maxCount = s.Count
		}
	}

	stageColors := []lipgloss.Color{m.theme.Blue, m.theme.Sky, m.theme.Green, m.theme.Peach}
	labelW := 12
	barMaxW := m.width - labelW - 20
	if barMaxW < 10 {
		barMaxW = 10
	}

	var lines []string
	lines = append(lines, "")
	for i, s := range m.stages {
		barW := 0
		if maxCount > 0 {
			barW = s.Count * barMaxW / maxCount
		}
		if barW < 1 && s.Count > 0 {
			barW = 1
		}
		color := m.theme.Text
		if i < len(stageColors) {
			color = stageColors[i]
		}
		bar := lipgloss.NewStyle().Foreground(color).Render(strings.Repeat("█", barW))
		label := lipgloss.NewStyle().Foreground(m.theme.Text).Width(labelW).Render(s.Label)
		count := lipgloss.NewStyle().Foreground(m.theme.Subtext).Render(fmt.Sprintf("%d", s.Count))
		lines = append(lines, "  "+label+bar+" "+count)
	}
	body := strings.Join(lines, "\n")

	help := lipgloss.NewStyle().Foreground(m.theme.Subtext).Padding(0, 2).Render("q/esc back")

	return lipgloss.JoinVertical(lipgloss.Left, header, body, help)
}
