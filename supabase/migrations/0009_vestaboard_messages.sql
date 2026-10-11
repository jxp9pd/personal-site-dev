-- Private Leave a Note history. Only the server's service role can access it.
create table public.vestaboard_messages (
  id uuid primary key,
  submitted_at timestamptz not null,
  original_message text check (length(original_message) <= 240),
  characters jsonb not null check (jsonb_typeof(characters) = 'array'),
  sender_ip inet,
  outcome text not null default 'unknown'
    check (outcome in ('unknown', 'accepted', 'rejected')),
  http_status smallint check (http_status between 100 and 599)
);

comment on column public.vestaboard_messages.original_message is
  'Unmodified composer input. Null for legacy clients that submit only a character grid.';
comment on column public.vestaboard_messages.outcome is
  'Cloud acceptance, definite rejection, or unknown. Physical delivery is not confirmed.';

create index vestaboard_messages_submitted_at_idx
  on public.vestaboard_messages (submitted_at desc);
create index vestaboard_messages_sender_ip_submitted_at_idx
  on public.vestaboard_messages (sender_ip, submitted_at desc);

alter table public.vestaboard_messages enable row level security;
revoke all on public.vestaboard_messages from public, anon, authenticated;
grant select, insert, update on public.vestaboard_messages to service_role;
