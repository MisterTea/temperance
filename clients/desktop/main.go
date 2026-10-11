// Temperance desktop application. WireGuard owns the encrypted data plane.
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Tunnel struct {
	Address    string `json:"address"`
	AddressV6  string `json:"address_v6"`
	DNS        string `json:"dns"`
	Endpoint   string `json:"endpoint"`
	PublicKey  string `json:"public_key"`
	AllowedIPs string `json:"allowed_ips"`
	Keepalive  int    `json:"keepalive"`
}
type State struct {
	DeviceID string          `json:"device_id"`
	Token    string          `json:"token,omitempty"`
	Version  int             `json:"version"`
	Policy   json.RawMessage `json:"policy"`
	Tunnel   Tunnel          `json:"tunnel"`
}
type Identity struct {
	Service    string `json:"service"`
	PrivateKey string `json:"private_key"`
	State      State  `json:"state"`
}
type App struct {
	mu                 sync.Mutex
	identity           Identity
	dir, nonce, status string
	connected          bool
	client             *http.Client
}

func configuration(private string, t Tunnel) (string, error) {
	for _, k := range []string{private, t.PublicKey} {
		b, e := base64.StdEncoding.DecodeString(k)
		if e != nil || len(b) != 32 {
			return "", fmt.Errorf("invalid tunnel key")
		}
	}
	for _, address := range []string{t.Address, t.AddressV6} {
		if _, _, e := net.ParseCIDR(address); e != nil {
			return "", e
		}
	}
	if net.ParseIP(t.DNS) == nil {
		return "", fmt.Errorf("invalid DNS address")
	}
	host, port, e := net.SplitHostPort(t.Endpoint)
	if e != nil || net.ParseIP(host) == nil || strings.ContainsAny(port, "\r\n") {
		return "", fmt.Errorf("invalid endpoint")
	}
	if _, e = net.LookupPort("udp", port); e != nil {
		return "", e
	}
	// Never accept scripts/routes supplied by the control plane. All routes are fixed.
	result := fmt.Sprintf("[Interface]\nPrivateKey = %s\nAddress = %s, %s\nDNS = %s\n\n[Peer]\nPublicKey = %s\nEndpoint = %s\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n", private, t.Address, t.AddressV6, t.DNS, t.PublicKey, t.Endpoint)
	return result, nil
}
func validService(raw string) (string, error) {
	u, e := url.Parse(strings.TrimRight(raw, "/"))
	if e != nil {
		return "", e
	}
	if u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("enter an HTTPS service origin")
	}
	return strings.TrimRight(u.String(), "/"), nil
}
func (a *App) request(method, path string, body any, state *State) error {
	var input io.Reader
	if body != nil {
		b, e := json.Marshal(body)
		if e != nil {
			return e
		}
		input = bytes.NewReader(b)
	}
	req, e := http.NewRequest(method, a.identity.Service+path, input)
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	if a.identity.State.Token != "" {
		req.Header.Set("Authorization", "Bearer "+a.identity.State.Token)
	}
	response, e := a.client.Do(req)
	if e != nil {
		return e
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("policy service returned %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(state)
}
func (a *App) save() error {
	conf, e := configuration(a.identity.PrivateKey, a.identity.State.Tunnel)
	if e != nil {
		return e
	}
	data, e := json.MarshalIndent(a.identity, "", "  ")
	if e != nil {
		return e
	}
	for name, body := range map[string][]byte{"identity.json": data, "temperance.conf": []byte(conf)} {
		tmp := filepath.Join(a.dir, name+".tmp")
		if e = os.WriteFile(tmp, body, 0600); e != nil {
			return e
		}
		target := filepath.Join(a.dir, name)
		// On Windows rename does not replace existing files.
		if runtime.GOOS == "windows" {
			if e = os.Remove(target); e != nil && !os.IsNotExist(e) {
				return e
			}
		}
		if e = os.Rename(tmp, target); e != nil {
			return e
		}
	}
	return nil
}
func (a *App) tunnel(up bool) error {
	if up && runtime.GOOS == "linux" {
		if exec.Command("wg", "show", "temperance").Run() == nil {
			a.connected = true
			return nil
		}
	}
	if up && runtime.GOOS == "windows" {
		output, err := exec.Command("sc.exe", "query", "WireGuardTunnel$temperance").CombinedOutput()
		if err == nil {
			if strings.Contains(string(output), "RUNNING") {
				a.connected = true
				return nil
			}
			if err = exec.Command("sc.exe", "start", "WireGuardTunnel$temperance").Run(); err == nil {
				a.connected = true
				return nil
			}
		}
	}
	var cmd *exec.Cmd
	conf := filepath.Join(a.dir, "temperance.conf")
	if runtime.GOOS == "windows" {
		program := filepath.Join(os.Getenv("ProgramFiles"), "WireGuard", "wireguard.exe")
		if up {
			cmd = exec.Command(program, "/installtunnelservice", conf)
		} else {
			cmd = exec.Command(program, "/uninstalltunnelservice", "temperance")
		}
	} else {
		verb := "down"
		if up {
			verb = "up"
		}
		cmd = exec.Command("wg-quick", verb, conf)
	}
	output, e := cmd.CombinedOutput()
	if e != nil {
		return fmt.Errorf("WireGuard: %v: %s", e, string(output))
	}
	a.connected = up
	return nil
}

var page = template.Must(template.New("app").Parse(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Temperance</title><style>body{font:16px system-ui;background:#eef3ed;color:#254436;max-width:650px;margin:60px auto;padding:24px}h1{font:42px Georgia}input,button{font:inherit;padding:12px;box-sizing:border-box;border:1px solid #cbd9cc;border-radius:8px}input{width:100%;margin:7px 0 20px}button{background:#26715d;color:white;cursor:pointer}section{background:white;padding:24px;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}</style><h1>Temperance</h1><p>Your family's rules, wherever you go.</p><section><p>{{.Status}}</p>{{if .Enrolled}}<p>Policy version: {{.Version}} · VPN installed: {{.Connected}}</p><pre>{{.Policy}}</pre><form method="post" action="/connect"><input type="hidden" name="nonce" value="{{.Nonce}}"><button>Install / start VPN</button></form><br><form method="post" action="/refresh"><input type="hidden" name="nonce" value="{{.Nonce}}"><button>Refresh policy</button></form>{{else}}<form method="post" action="/enroll"><input type="hidden" name="nonce" value="{{.Nonce}}"><label>Policy service<input name="service" type="url" placeholder="https://policy.example.com" required></label><label>Enrollment code<input name="code" required autocomplete="off"></label><label>Device name<input name="name" required maxlength="80"></label><button>Enroll this device</button></form>{{end}}</section><p>Rules are enforced at the VPN gateway. Administrative privileges are required to install the tunnel. Use OS management/lockdown to prevent disabling or bypassing it.</p></html>`))

func (a *App) refresh() error {
	state := State{}
	if e := a.request("GET", "/v1/device/state", nil, &state); e != nil {
		return e
	}
	state.Token = a.identity.State.Token
	if _, e := configuration(a.identity.PrivateKey, state.Tunnel); e != nil {
		return e
	}
	// Do not silently reconnect a live tunnel to a changed server.
	if a.connected && state.Tunnel != a.identity.State.Tunnel {
		return fmt.Errorf("tunnel provisioning changed; restart with administrator supervision")
	}
	a.identity.State = state
	return a.save()
}
func (a *App) handler(w http.ResponseWriter, r *http.Request) {
	if r.Host != r.Context().Value(hostKey{}).(string) {
		http.Error(w, "Use the local application URL", 403)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.Method == "POST" {
		r.Body = http.MaxBytesReader(w, r.Body, 8192)
		if e := r.ParseForm(); e != nil || r.FormValue("nonce") != a.nonce || r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "Invalid origin", 403)
			return
		}
		var e error
		switch r.URL.Path {
		case "/enroll":
			if a.identity.State.DeviceID != "" {
				e = fmt.Errorf("already enrolled")
				break
			}
			a.identity.Service, e = validService(r.FormValue("service"))
			if e != nil {
				break
			}
			// Private material never leaves this device.
			private, e2 := ecdh.X25519().GenerateKey(rand.Reader)
			if e2 != nil {
				e = e2
				break
			}
			a.identity.PrivateKey = base64.StdEncoding.EncodeToString(private.Bytes())
			body := map[string]string{"name": r.FormValue("name"), "code": r.FormValue("code"), "public_key": base64.StdEncoding.EncodeToString(private.PublicKey().Bytes())}
			e = a.request("POST", "/v1/enroll", body, &a.identity.State)
			if e == nil {
				e = a.save()
			}
		case "/connect":
			if a.identity.State.DeviceID == "" {
				e = fmt.Errorf("enroll first")
				break
			}
			e = a.refresh()
			if e == nil {
				e = a.tunnel(true)
			}
		case "/refresh":
			e = a.refresh()
		default:
			http.NotFound(w, r)
			return
		}
		if e != nil {
			a.status = e.Error()
		} else {
			a.status = "Ready. Rules are enforced by your gateway."
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	view := struct {
		Status, Nonce, Policy string
		Enrolled, Connected   bool
		Version               int
	}{a.status, a.nonce, string(a.identity.State.Policy), a.identity.State.DeviceID != "", a.connected, a.identity.State.Version}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = page.Execute(w, view)
}

type hostKey struct{}

func main() {
	dir := flag.String("data", "", "Private state directory (installer supplies this)")
	flag.Parse()
	if *dir == "" {
		home, e := os.UserConfigDir()
		if e != nil {
			panic(e)
		}
		*dir = filepath.Join(home, "temperance")
	}
	absolute, e := filepath.Abs(*dir)
	if e != nil {
		panic(e)
	}
	if e = os.MkdirAll(absolute, 0700); e != nil {
		panic(e)
	}
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		panic(e)
	}
	a := &App{dir: absolute, nonce: base64.RawURLEncoding.EncodeToString(nonce), status: "Enroll to install your family's VPN.", client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
	if b, e := os.ReadFile(filepath.Join(absolute, "identity.json")); e == nil {
		if e = json.Unmarshal(b, &a.identity); e != nil {
			panic(e)
		}
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		panic(e)
	}
	origin := "http://" + listener.Addr().String()
	fmt.Println("Temperance:", origin)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			a.mu.Lock()
			if a.identity.State.DeviceID != "" {
				if e := a.refresh(); e != nil {
					a.status = e.Error() + "; existing VPN remains installed"
				}
			}
			a.mu.Unlock()
		}
	}()
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = r.WithContext(context.WithValue(r.Context(), hostKey{}, listener.Addr().String()))
		a.handler(w, r)
	})}
	if e = server.Serve(listener); e != nil {
		panic(e)
	}
}
