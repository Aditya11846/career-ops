package data

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// NeedsInputEntry mirrors one entry in data/needs-input-queue.json (see
// needs-input.mjs's addEntry() for the canonical schema).
type NeedsInputEntry struct {
	ID          string `json:"id"`
	CreatedAt   string `json:"created_at"`
	Source      string `json:"source"`
	ReportRef   string `json:"report_ref"`
	Company     string `json:"company"`
	Role        string `json:"role"`
	Reason      string `json:"reason"`
	Status      string `json:"status"`
	ResolvedAt  string `json:"resolved_at"`
}

// LoadNeedsInputQueue reads data/needs-input-queue.json. Missing or
// unparseable files return an empty slice rather than an error — this is a
// read-only display panel, not a producer, so it tolerates the file not
// existing yet (mirrors career.go's ParseApplications/LoadReportSummary
// pattern of returning a zero value on any read/parse failure).
func LoadNeedsInputQueue(careerOpsPath string) []NeedsInputEntry {
	path := filepath.Join(careerOpsPath, "data", "needs-input-queue.json")
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var entries []NeedsInputEntry
	if err := json.Unmarshal(content, &entries); err != nil {
		return nil
	}
	return entries
}

// OpenNeedsInputEntries filters to status == "open", the ones worth
// surfacing at the top of the panel.
func OpenNeedsInputEntries(entries []NeedsInputEntry) []NeedsInputEntry {
	var open []NeedsInputEntry
	for _, e := range entries {
		if e.Status == "open" {
			open = append(open, e)
		}
	}
	return open
}
