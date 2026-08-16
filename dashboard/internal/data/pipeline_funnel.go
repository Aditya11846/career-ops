package data

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"

	"github.com/santifer/career-ops/dashboard/internal/model"
)

// PipelineFunnelStage is one stage in the scanned->scored->applied->interview
// funnel (broader than ComputeProgressMetrics' FunnelStages, which only
// covers tracker rows — this adds the "scanned" stage from scan-history.tsv,
// upstream of anything reaching the tracker at all).
type PipelineFunnelStage struct {
	Label string
	Count int
}

// countScannedURLs counts distinct URLs ever seen by scan.mjs, from
// data/scan-history.tsv's first (url) column. Missing file -> 0, matching
// this package's tolerate-missing-file convention.
func countScannedURLs(careerOpsPath string) int {
	path := filepath.Join(careerOpsPath, "data", "scan-history.tsv")
	f, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer f.Close()

	seen := map[string]struct{}{}
	scanner := bufio.NewScanner(f)
	first := true
	for scanner.Scan() {
		if first {
			first = false // skip header row
			continue
		}
		line := scanner.Text()
		if line == "" {
			continue
		}
		url := line
		if idx := strings.IndexByte(line, '\t'); idx >= 0 {
			url = line[:idx]
		}
		if url == "" {
			continue
		}
		seen[url] = struct{}{}
	}
	return len(seen)
}

// ComputePipelineFunnel builds the scanned->scored->applied->interview
// funnel from scan-history.tsv (scanned) and the already-parsed tracker rows
// (scored/applied/interview — reuses ParseApplications' output rather than
// re-parsing applications.md a second time).
func ComputePipelineFunnel(careerOpsPath string, apps []model.CareerApplication) []PipelineFunnelStage {
	scanned := countScannedURLs(careerOpsPath)
	scored := len(apps)
	applied, interview := 0, 0
	for _, app := range apps {
		switch NormalizeStatus(app.Status) {
		case "applied", "responded", "interview", "offer", "hired":
			applied++
		}
		switch NormalizeStatus(app.Status) {
		case "interview", "offer", "hired":
			interview++
		}
	}

	return []PipelineFunnelStage{
		{Label: "Scanned", Count: scanned},
		{Label: "Scored", Count: scored},
		{Label: "Applied", Count: applied},
		{Label: "Interview", Count: interview},
	}
}
