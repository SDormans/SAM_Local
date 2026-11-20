package server

import "testing"

func TestValidateLocalRepositoryPath(t *testing.T) {
	root := "/run/desktop/mnt/host/c/Users/me"
	ok, err := validateLocalRepositoryPath(root+"/", root+"/code/demo/")
	if err != nil || ok != root+"/code/demo" {
		t.Fatalf("got %q, %v", ok, err)
	}
	for _, bad := range []string{"", "code/demo", root, root + "/../etc", "/etc/passwd", root + "x/y", root + "/a,b", root + "/a\x00"} {
		if _, err := validateLocalRepositoryPath(root, bad); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
	win, err := validateLocalRepositoryPath("/run/desktop/mnt/host", `C:\Users\me\code\demo`)
	if err != nil || win != "/run/desktop/mnt/host/c/Users/me/code/demo" {
		t.Fatalf("windows path: got %q, %v", win, err)
	}
	if _, err := validateLocalRepositoryPath("/run/desktop/mnt/host", `C:\Users\..\Windows`); err == nil {
		t.Fatal("expected rejection for windows traversal")
	}
	if _, err := validateLocalRepositoryPath("", root+"/a"); err == nil {
		t.Fatal("expected rejection without a configured root")
	}
}

func TestLocalWorkspaceMountAndProvider(t *testing.T) {
	if got := localWorkspaceMount("/mnt/c/code/demo"); got != "source=/mnt/c/code/demo,target=/workspaces/demo,type=bind" {
		t.Fatalf("unexpected mount %q", got)
	}
	if !isLocalRepoProvider(" Local ") || isLocalRepoProvider("github") {
		t.Fatal("provider detection wrong")
	}
}
