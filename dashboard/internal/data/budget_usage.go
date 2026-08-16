package data

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Display-only defaults mirroring budget-tracker.mjs's DEFAULT_BUDGET. Not
// enforcement (that lives in budget-tracker.mjs / config/profile.yml's
// budget: block) — just the fallback shown here if usage-today.json is
// missing or a user hasn't customized their profile's budget: block. Reading
// the real profile.yml override would need a YAML dependency this module
// doesn't otherwise need; a display panel showing slightly-stale defaults
// is an acceptable tradeoff over adding one for this alone.
const (
	DefaultDailyLLMCalls = 300
	DefaultTier2DailyCap = 25
)

// Tier2Applies mirrors budget-tracker.mjs's usage-today.json tier2_applies shape.
type Tier2Applies struct {
	LinkedIn int `json:"linkedin"`
	Naukri   int `json:"naukri"`
}

// BudgetUsage mirrors budget-tracker.mjs's data/usage-today.json shape.
type BudgetUsage struct {
	Date         string       `json:"date"`
	LLMCalls     int          `json:"llm_calls"`
	Tier2Applies Tier2Applies `json:"tier2_applies"`
}

// LoadBudgetUsage reads data/usage-today.json. Returns a zero-value
// BudgetUsage (all counts 0, empty date) if the file doesn't exist yet —
// e.g. before budget-tracker.mjs has run for the first time today.
func LoadBudgetUsage(careerOpsPath string) BudgetUsage {
	path := filepath.Join(careerOpsPath, "data", "usage-today.json")
	content, err := os.ReadFile(path)
	if err != nil {
		return BudgetUsage{}
	}
	var usage BudgetUsage
	if err := json.Unmarshal(content, &usage); err != nil {
		return BudgetUsage{}
	}
	return usage
}
