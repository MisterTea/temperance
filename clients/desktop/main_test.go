package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
)

func TestConfigRejectsInjectionAndUsesFullTunnel(t *testing.T) {
	k, _ := ecdh.X25519().GenerateKey(rand.Reader)
	private := base64.StdEncoding.EncodeToString(k.Bytes())
	pub := base64.StdEncoding.EncodeToString(k.PublicKey().Bytes())
	c := Tunnel{Address: "10.77.0.2/32", AddressV6: "fd77::2/128", DNS: "10.77.0.1", Endpoint: "192.0.2.1:51820", PublicKey: pub}
	s, e := configuration(private, c)
	if e != nil || !strings.Contains(s, "AllowedIPs = 0.0.0.0/0, ::/0") {
		t.Fatal(s, e)
	}
	c.Endpoint = "192.0.2.1:51820\nPostUp = malicious"
	if _, e = configuration(private, c); e == nil {
		t.Fatal("accepted config injection")
	}
}
func TestHTTPSRequired(t *testing.T) {
	for _, s := range []string{"http://example.com", "https://user:pass@example.com", "https://example.com/?token=a"} {
		if _, e := validService(s); e == nil {
			t.Fatal(s)
		}
	}
	if _, e := validService("https://policy.example.com"); e != nil {
		t.Fatal(e)
	}
}
