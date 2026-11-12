"""Private, server-side records of Leave a Note submissions."""
from datetime import datetime, timezone
import ipaddress
import logging
from uuid import uuid4

from board import DEFINITE_REJECTIONS
from supabase_rest import SupabaseUnavailable


class HistoryUnavailable(SupabaseUnavailable):
    pass


def sender_ip(peer, forwarded):
    """Only the local nginx proxy may supply X-Real-IP; it overwrites the header."""
    address = ipaddress.ip_address(peer)
    if not address.is_loopback:
        return str(address)
    try:
        return str(ipaddress.ip_address(forwarded))
    except ValueError:
        return None


class MessageHistory:
    def __init__(self, client):
        self.client = client
        self.endpoint = client.table_url('vestaboard_messages')

    def _write(self, method, body, suffix=''):
        try:
            self.client.request(method, self.endpoint + suffix, body, {'Prefer': 'return=minimal'})
        except SupabaseUnavailable:
            raise HistoryUnavailable() from None

    def begin(self, original_message, characters, address):
        record_id = str(uuid4())
        self._write('POST', {
            'id': record_id, 'submitted_at': datetime.now(timezone.utc).isoformat(),
            'original_message': original_message, 'characters': characters,
            'sender_ip': address, 'outcome': 'unknown',
        })
        return record_id

    def finish(self, record_id, status):
        outcome = 'accepted' if status == 200 else 'rejected' if status in DEFINITE_REJECTIONS else 'unknown'
        try:
            self._write('PATCH', {'outcome': outcome, 'http_status': status}, '?id=eq.' + record_id)
        except HistoryUnavailable:
            # The message, time, and sender are already durable. Leave the
            # outcome unknown; never repeat a board write to repair history.
            logging.error('Could not update delivery outcome for message history record %s', record_id)
