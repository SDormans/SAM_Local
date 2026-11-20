package acp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// Spec 036 T029: OpenCode uses only the destination the control plane selected, and an
// agent-key failure is surfaced once without trying another destination.
func newLocalInferenceHost(t *testing.T, handler http.HandlerFunc) (*SessionHost, *int32) {
	t.Helper()
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	host := NewSessionHost(SessionHostConfig{
		GatewayConfig: GatewayConfig{
			ControlPlaneURL: server.URL,
			WorkspaceID:     "workspace-1",
			SessionID:       "session-1",
			CallbackToken:   "callback-token",
			HTTPClient:      server.Client(),
		},
	})
	return host, &calls
}

func TestFetchAgentKeyLocalGatewayCarriesNoCloudKey(t *testing.T) {
	host, _ := newLocalInferenceHost(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"apiKey":"","credentialKind":"api-key","providerMode":"local-model-gateway","inferenceConfig":{"provider":"local-model-gateway","baseURL":"http://172.18.0.1:4100/local-model/v1","model":"qwen2.5:0.5b","apiKeySource":"callback-token"}}`))
	})
	cred, err := host.fetchAgentKey(context.Background(), "opencode")
	if err != nil {
		t.Fatalf("fetchAgentKey: %v", err)
	}
	if cred.credential != "" {
		t.Fatalf("local destination must not carry a cloud key, got %q", cred.credential)
	}
	if cred.providerMode != "local-model-gateway" {
		t.Fatalf("providerMode = %q, want local-model-gateway", cred.providerMode)
	}
	if cred.inferenceConfig == nil || cred.inferenceConfig.Provider != "local-model-gateway" {
		t.Fatalf("inferenceConfig = %+v, want local-model-gateway", cred.inferenceConfig)
	}
}

func TestFetchAgentKeyFailureIsNotRetriedElsewhere(t *testing.T) {
	host, calls := newLocalInferenceHost(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"LOCAL_MODEL_NOT_CONFIGURED","message":"Configure a local model in Setup"}`))
	})
	if _, err := host.fetchAgentKey(context.Background(), "opencode"); err == nil {
		t.Fatal("expected an error when the selected destination is unavailable")
	}
	if got := atomic.LoadInt32(calls); got != 1 {
		t.Fatalf("control plane called %d times, want exactly 1", got)
	}
}
