"""Checks Supabase Auth session tokens for the door service."""
import json
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class SupabaseAuth:
    def __init__(self, url, anon_key, opener=urlopen):
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('', '/') or parsed.query or parsed.fragment):
            raise ValueError('SUPABASE_URL must be an HTTPS project URL.')
        self.url, self.anon_key, self.opener = url.rstrip('/'), anon_key, opener

    def user_id(self, access_token):
        """The Supabase Auth user id for a session token, or None if it is not valid or Auth is unreachable."""
        request = Request(self.url + '/auth/v1/user', headers={
            'apikey': self.anon_key, 'Authorization': 'Bearer ' + access_token})
        try:
            with self.opener(request, timeout=4) as response:
                user = json.loads(response.read(64 * 1024))
        except (OSError, ValueError):
            return None
        return user.get('id') if isinstance(user, dict) else None
