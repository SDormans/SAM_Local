package acp

import "testing"

func TestSessionModelID(t *testing.T) {
	cases := []struct {
		agent, provider, model, want string
	}{
		{"opencode", "custom", "qwen2.5:0.5b", "custom/" + sanitizeModelAlias("qwen2.5:0.5b")},
		{"opencode", "custom", "custom/already", "custom/already"},
		{"opencode", "opencode-zen", "big-pickle", "big-pickle"},
		{"claude-code", "", "sonnet", "sonnet"},
	}
	for _, c := range cases {
		got := sessionModelID(c.agent, &agentSettingsPayload{Model: c.model, OpencodeProvider: c.provider})
		if got != c.want {
			t.Errorf("sessionModelID(%q,%q,%q)=%q want %q", c.agent, c.provider, c.model, got, c.want)
		}
	}
}
