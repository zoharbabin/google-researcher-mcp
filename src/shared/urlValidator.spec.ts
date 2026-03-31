import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { validateUrlForSSRF, SSRFProtectionError, getSSRFOptionsFromEnv, ssrfSafeFetch } from './urlValidator.js';

describe('SSRF URL Validator', () => {
  describe('Protocol validation', () => {
    it('should allow http URLs', async () => {
      // Public DNS will resolve — no throw expected for valid public URLs
      await expect(validateUrlForSSRF('http://www.google.com')).resolves.toBeUndefined();
    });

    it('should allow https URLs', async () => {
      await expect(validateUrlForSSRF('https://www.google.com')).resolves.toBeUndefined();
    });

    it('should block ftp protocol', async () => {
      await expect(validateUrlForSSRF('ftp://example.com/file')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block file protocol', async () => {
      await expect(validateUrlForSSRF('file:///etc/passwd')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block invalid URLs', async () => {
      await expect(validateUrlForSSRF('not-a-url')).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('Private IP blocking', () => {
    it('should block localhost 127.0.0.1', async () => {
      await expect(validateUrlForSSRF('http://127.0.0.1/secret')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block 10.x.x.x range', async () => {
      await expect(validateUrlForSSRF('http://10.0.0.1/internal')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block 192.168.x.x range', async () => {
      await expect(validateUrlForSSRF('http://192.168.1.1/admin')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block 172.16.x.x range', async () => {
      await expect(validateUrlForSSRF('http://172.16.0.1/')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block 0.0.0.0', async () => {
      await expect(validateUrlForSSRF('http://0.0.0.0/')).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('Cloud metadata endpoint blocking', () => {
    it('should block AWS metadata endpoint (169.254.169.254)', async () => {
      await expect(validateUrlForSSRF('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(SSRFProtectionError);
    });

    it('should block GCP metadata hostname', async () => {
      await expect(validateUrlForSSRF('http://metadata.google.internal/')).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('IPv6 blocking', () => {
    it('should block IPv6 loopback [::1]', async () => {
      await expect(validateUrlForSSRF('http://[::1]/')).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('Public URL allowance', () => {
    it('should allow public URLs', async () => {
      await expect(validateUrlForSSRF('https://www.example.com')).resolves.toBeUndefined();
    });

    it('should allow YouTube URLs', async () => {
      await expect(validateUrlForSSRF('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).resolves.toBeUndefined();
    });
  });

  describe('DNS resolution blocking', () => {
    it('should block localhost hostname', async () => {
      await expect(validateUrlForSSRF('http://localhost/secret')).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('allowPrivateIPs option', () => {
    const opts = { allowPrivateIPs: true };

    it('should allow 127.0.0.1 when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://127.0.0.1/', opts)).resolves.toBeUndefined();
    });

    it('should allow 10.x.x.x when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://10.0.0.1/', opts)).resolves.toBeUndefined();
    });

    it('should allow 192.168.x.x when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://192.168.1.1/', opts)).resolves.toBeUndefined();
    });

    it('should allow localhost hostname when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://localhost/', opts)).resolves.toBeUndefined();
    });

    it('should allow IPv6 loopback when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://[::1]/', opts)).resolves.toBeUndefined();
    });

    it('should allow 169.254.x.x when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('http://169.254.169.254/', opts)).resolves.toBeUndefined();
    });

    it('should still block non-HTTP protocols when allowPrivateIPs is true', async () => {
      await expect(validateUrlForSSRF('ftp://127.0.0.1/', opts)).rejects.toThrow(SSRFProtectionError);
    });

    it('should still block metadata hostnames when allowPrivateIPs is true', async () => {
      await expect(
        validateUrlForSSRF('http://metadata.google.internal/', opts)
      ).rejects.toThrow(SSRFProtectionError);
    });
  });

  describe('allowedDomains option', () => {
    it('should allow exact domain match', async () => {
      await expect(
        validateUrlForSSRF('https://example.com/path', { allowedDomains: ['example.com'] })
      ).resolves.toBeUndefined();
    });

    it('should allow subdomain of allowed domain', async () => {
      await expect(
        validateUrlForSSRF('https://sub.example.com/path', { allowedDomains: ['example.com'] })
      ).resolves.toBeUndefined();
    });

    it('should block domain not in allowlist', async () => {
      await expect(
        validateUrlForSSRF('https://evil.com/', { allowedDomains: ['example.com'] })
      ).rejects.toThrow(SSRFProtectionError);
    });

    it('should include domain name in error message', async () => {
      await expect(
        validateUrlForSSRF('https://evil.com/', { allowedDomains: ['example.com'] })
      ).rejects.toThrow(/not in the allowed domains list/);
    });

    it('should support multiple allowed domains', async () => {
      const opts = { allowedDomains: ['example.com', 'github.com'] };
      await expect(validateUrlForSSRF('https://example.com/', opts)).resolves.toBeUndefined();
      await expect(validateUrlForSSRF('https://github.com/', opts)).resolves.toBeUndefined();
      await expect(validateUrlForSSRF('https://evil.com/', opts)).rejects.toThrow(SSRFProtectionError);
    });

    it('should be case-insensitive', async () => {
      await expect(
        validateUrlForSSRF('https://EXAMPLE.COM/', { allowedDomains: ['example.com'] })
      ).resolves.toBeUndefined();
    });

    it('should still block metadata hostnames even if in allowlist', async () => {
      await expect(
        validateUrlForSSRF('http://metadata.google.internal/', {
          allowedDomains: ['metadata.google.internal']
        })
      ).rejects.toThrow(SSRFProtectionError);
    });

    it('should allow all domains when allowedDomains is not set', async () => {
      await expect(validateUrlForSSRF('https://any-domain.com/')).resolves.toBeUndefined();
    });

    it('should allow all domains when allowedDomains is empty', async () => {
      await expect(
        validateUrlForSSRF('https://any-domain.com/', { allowedDomains: [] })
      ).resolves.toBeUndefined();
    });
  });

  describe('getSSRFOptionsFromEnv', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      delete process.env.ALLOW_PRIVATE_IPS;
      delete process.env.ALLOWED_DOMAINS;
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('should return defaults when no env vars are set', () => {
      const opts = getSSRFOptionsFromEnv();
      expect(opts.allowPrivateIPs).toBe(false);
      expect(opts.allowedDomains).toBeUndefined();
    });

    it('should parse ALLOW_PRIVATE_IPS=true', () => {
      process.env.ALLOW_PRIVATE_IPS = 'true';
      expect(getSSRFOptionsFromEnv().allowPrivateIPs).toBe(true);
    });

    it('should parse ALLOW_PRIVATE_IPS=TRUE (case insensitive)', () => {
      process.env.ALLOW_PRIVATE_IPS = 'TRUE';
      expect(getSSRFOptionsFromEnv().allowPrivateIPs).toBe(true);
    });

    it('should treat ALLOW_PRIVATE_IPS=false as false', () => {
      process.env.ALLOW_PRIVATE_IPS = 'false';
      expect(getSSRFOptionsFromEnv().allowPrivateIPs).toBe(false);
    });

    it('should parse ALLOWED_DOMAINS with single domain', () => {
      process.env.ALLOWED_DOMAINS = 'example.com';
      expect(getSSRFOptionsFromEnv().allowedDomains).toEqual(['example.com']);
    });

    it('should parse ALLOWED_DOMAINS with multiple domains and trim whitespace', () => {
      process.env.ALLOWED_DOMAINS = 'example.com, github.com , google.com';
      expect(getSSRFOptionsFromEnv().allowedDomains).toEqual(['example.com', 'github.com', 'google.com']);
    });

    it('should return undefined for empty ALLOWED_DOMAINS', () => {
      process.env.ALLOWED_DOMAINS = '';
      expect(getSSRFOptionsFromEnv().allowedDomains).toBeUndefined();
    });

    it('should return undefined for whitespace-only ALLOWED_DOMAINS', () => {
      process.env.ALLOWED_DOMAINS = '   ';
      expect(getSSRFOptionsFromEnv().allowedDomains).toBeUndefined();
    });
  });

  describe('ssrfSafeFetch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should fetch a URL that returns 200 directly', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('OK', { status: 200 })
      );

      const response = await ssrfSafeFetch('https://example.com/page');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('OK');
    });

    it('should follow redirects and validate each hop', async () => {
      let callCount = 0;
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response('', {
            status: 302,
            headers: { Location: 'https://example.com/final' },
          });
        }
        return new Response('Final', { status: 200 });
      });

      const response = await ssrfSafeFetch('https://example.com/start');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Final');
      expect(callCount).toBe(2);
    });

    it('should block redirect to private IP', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
        })
      );

      await expect(
        ssrfSafeFetch('https://example.com/redirect')
      ).rejects.toThrow(SSRFProtectionError);
    });

    it('should block redirect to localhost', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { Location: 'http://127.0.0.1:8080/admin' },
        })
      );

      await expect(
        ssrfSafeFetch('https://example.com/redirect')
      ).rejects.toThrow(SSRFProtectionError);
    });

    it('should block redirect to internal network', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { Location: 'http://10.0.0.1/internal' },
        })
      );

      await expect(
        ssrfSafeFetch('https://example.com/redirect')
      ).rejects.toThrow(SSRFProtectionError);
    });

    it('should throw on too many redirects', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('', {
          status: 302,
          headers: { Location: 'https://example.com/loop' },
        })
      );

      await expect(
        ssrfSafeFetch('https://example.com/loop')
      ).rejects.toThrow(/Too many redirects/);
    });

    it('should handle redirect with no Location header', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('No Location', { status: 302 })
      );

      const response = await ssrfSafeFetch('https://example.com/no-location');
      expect(response.status).toBe(302);
    });

    it('should resolve relative redirect URLs', async () => {
      let callCount = 0;
      const urls: string[] = [];
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (input) => {
        urls.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as any).url);
        callCount++;
        if (callCount === 1) {
          return new Response('', {
            status: 301,
            headers: { Location: '/other-path' },
          });
        }
        return new Response('Done', { status: 200 });
      });

      const response = await ssrfSafeFetch('https://example.com/start');
      expect(response.status).toBe(200);
      expect(urls[1]).toBe('https://example.com/other-path');
    });

    it('should pass fetchInit options through to fetch', async () => {
      const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
        new Response('OK', { status: 200 })
      );
      globalThis.fetch = mockFetch;

      await ssrfSafeFetch('https://example.com/page', {}, {
        headers: { 'User-Agent': 'TestBot/1.0' },
      });

      const callArgs = mockFetch.mock.calls[0];
      expect((callArgs[1] as any).redirect).toBe('manual');
      expect((callArgs[1] as any).headers['User-Agent']).toBe('TestBot/1.0');
    });

    it('should respect SSRF options allowing private IPs', async () => {
      globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async () => {
        return new Response('', {
          status: 302,
          headers: { Location: 'http://127.0.0.1:8080/internal' },
        });
      });

      // With allowPrivateIPs, redirect to 127.0.0.1 should be followed (not blocked)
      // It will keep redirecting, so it'll hit the max redirect limit
      await expect(
        ssrfSafeFetch('https://example.com/redirect', { allowPrivateIPs: true })
      ).rejects.toThrow(/Too many redirects/);
    });
  });
});
