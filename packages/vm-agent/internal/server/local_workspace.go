package server

import (
	"fmt"
	"path"
	"regexp"
	"strings"
)

// LocalRepoProvider marks a spec 036 local-desktop project: the repository is a folder on
// the user's machine that is bind-mounted into the workspace, never cloned.
const LocalRepoProvider = "local"

func isLocalRepoProvider(provider string) bool {
	return strings.EqualFold(strings.TrimSpace(provider), LocalRepoProvider)
}

// windowsDrivePath matches an absolute Windows path such as C:\Users\me\code.
var windowsDrivePath = regexp.MustCompile(`^([A-Za-z]):[\\/](.*)$`)

// validateLocalRepositoryPath maps a desktop project folder to the Docker daemon's view of it
// and accepts only clean absolute paths under root, so a request cannot mount arbitrary host
// paths. Windows drive paths are translated to Docker Desktop's host mount (root/<drive>/...).
func validateLocalRepositoryPath(root, repository string) (string, error) {
	root = strings.TrimRight(strings.TrimSpace(root), "/")
	repository = strings.TrimSpace(repository)
	if m := windowsDrivePath.FindStringSubmatch(repository); m != nil && root != "" {
		repository = root + "/" + strings.ToLower(m[1]) + "/" + strings.ReplaceAll(m[2], `\`, "/")
	}
	if root == "" || !strings.HasPrefix(root, "/") {
		return "", fmt.Errorf("local workspaces are not enabled on this node")
	}
	if !strings.HasPrefix(repository, "/") || strings.ContainsAny(repository, "\x00,\n\r") {
		return "", fmt.Errorf("local repository must be an absolute path")
	}
	for _, segment := range strings.Split(repository, "/") {
		if segment == ".." {
			return "", fmt.Errorf("local repository must not contain '..'")
		}
	}
	cleaned := path.Clean(repository)
	if cleaned == root || !strings.HasPrefix(cleaned, root+"/") {
		return "", fmt.Errorf("local repository must be inside %s", root)
	}
	return cleaned, nil
}

// localWorkspaceMount is the devcontainer workspaceMount for a bind-mounted local folder.
func localWorkspaceMount(hostPath string) string {
	return fmt.Sprintf("source=%s,target=/workspaces/%s,type=bind", hostPath, path.Base(hostPath))
}
