package main

import (
	"regexp"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/santifer/career-ops/dashboard/internal/data"
	"github.com/santifer/career-ops/dashboard/internal/theme"
	"github.com/santifer/career-ops/dashboard/internal/ui/screens"
)

var ansiRE = regexp.MustCompile(`\x1b\[[0-9;]*[a-zA-Z]`)

func stripANSIForDebug(s string) string {
	s = ansiRE.ReplaceAllString(s, "")
	if len(s) > 400 {
		s = s[:400]
	}
	return s
}

// Exercises the n/b/u key path against the real career-ops repo data (../),
// the same construction main() uses, without needing a live pty.
func TestNewPanelsOpenAndRender(t *testing.T) {
	careerOpsPath := ".."
	apps := data.ParseApplications(careerOpsPath)
	if apps == nil {
		t.Fatal("could not load applications.md from ../data")
	}
	metrics := data.ComputeMetrics(apps)
	progressMetrics := data.ComputeProgressMetrics(apps)
	th := theme.NewTheme("auto")
	pm := screens.NewPipelineModel(th, apps, metrics, careerOpsPath, 120, 40)

	m := appModel{
		pipeline:        pm,
		careerOpsPath:   careerOpsPath,
		theme:           th,
		progressMetrics: progressMetrics,
	}

	cases := []struct {
		key       string
		wantState viewState
		closeKey  string // key to return to the pipeline screen before the next case
	}{
		{"n", viewNeedsInput, "esc"},
		{"b", viewBudgetUsage, "esc"},
		{"u", viewFunnel, "esc"},
	}

	for _, c := range cases {
		if m.state != viewPipeline {
			t.Fatalf("precondition: expected viewPipeline before opening %q, got %v", c.key, m.state)
		}
		updated, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(c.key)})
		am, ok := updated.(appModel)
		if !ok {
			t.Fatalf("key %q: Update did not return appModel", c.key)
		}
		if cmd == nil {
			t.Fatalf("key %q: expected a cmd to open the panel, got nil", c.key)
		}
		msg := cmd()
		am2, cmd2 := am.Update(msg)
		am, ok = am2.(appModel)
		if !ok {
			t.Fatalf("key %q: second Update did not return appModel", c.key)
		}
		_ = cmd2
		if am.state != c.wantState {
			t.Fatalf("key %q: expected state %v, got %v", c.key, c.wantState, am.state)
		}
		view := am.View()
		if strings.TrimSpace(view) == "" {
			t.Fatalf("key %q: panel rendered empty view", c.key)
		}
		t.Logf("key %q -> state %v rendered %d bytes", c.key, am.state, len(view))
		t.Logf("key %q view snippet: %s", c.key, stripANSIForDebug(view))

		// Close back to the pipeline screen so the next case starts clean.
		closed, closeCmd := am.Update(tea.KeyMsg{Type: tea.KeyEsc})
		am, ok = closed.(appModel)
		if !ok {
			t.Fatalf("key %q: close Update did not return appModel", c.key)
		}
		if closeCmd != nil {
			closedMsg := closeCmd()
			closed2, _ := am.Update(closedMsg)
			am, ok = closed2.(appModel)
			if !ok {
				t.Fatalf("key %q: second close Update did not return appModel", c.key)
			}
		}
		if am.state != viewPipeline {
			t.Fatalf("key %q: expected to return to viewPipeline after esc, got %v", c.key, am.state)
		}
		m = am
	}
}
