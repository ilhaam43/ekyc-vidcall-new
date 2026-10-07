-- Runs after Jitsi token verification (priority 99). JWT identity is supplied by mod_auth_token.
local http = require 'net.http';
local json = require 'util.json';
local async = require 'util.async';
local st = require 'util.stanza';
local jid = require 'util.jid';
local util = module:require 'util';
local secret = os.getenv('INTERNAL_SECRET');
local api = os.getenv('EKYC_CALLS_URL') or 'http://calls:5030';
local recorder_domain = os.getenv('XMPP_RECORDER_DOMAIN') or 'recorder.meet.jitsi';
module:hook('muc-occupant-pre-join', function(event)
  local origin, stanza, room = event.origin, event.stanza, event.room;
  if util.is_admin(stanza.attr.from) or jid.host(stanza.attr.from) == recorder_domain then return; end
  local user = origin.jitsi_meet_context_user;
  if not user or not user.id or not user.session_id then
    origin.send(st.error_reply(stanza, 'auth', 'forbidden', 'Scoped eKYC session required')); return true;
  end
  local wait, done = async.waiter();
  local allowed = false; local role = nil;
  http.request(api .. '/internal/jitsi/admission', {
    method = 'POST';
    headers = { ['Content-Type'] = 'application/json'; ['X-Internal-Secret'] = secret; };
    body = json.encode({ room = jid.node(room.jid); user_id = user.id; session_id = user.session_id; });
  }, function(body, code)
    if code == 200 then local result = json.decode(body); allowed = result and result.success; role = result and result.data and result.data.role; end
    done();
  end);
  wait();
  if not allowed then origin.send(st.error_reply(stanza, 'auth', 'forbidden', 'Call admission denied')); return true; end
  local occupant = event.occupant;
  local bare_jid = occupant and occupant.bare_jid or jid.bare(stanza.attr.from);
  room:set_affiliation(true, bare_jid, role == 'agent' and 'owner' or 'member');
  if occupant then occupant.role = role == 'agent' and 'moderator' or 'participant'; end
end, 90);

-- Start the recorder only after the customer is an actual conference participant.
-- Retrying this notification is safe: the backend transition and outbox key are idempotent.
local function report_participant_joined(user, room_name, retries)
  http.request(api .. '/internal/jitsi/participant-joined', {
    method = 'POST';
    headers = { ['Content-Type'] = 'application/json'; ['X-Internal-Secret'] = secret; };
    body = json.encode({ room = room_name; user_id = user.id; session_id = user.session_id; });
  }, function(_, code)
    if code ~= 200 and retries > 0 then
      module:add_timer(1, function() report_participant_joined(user, room_name, retries - 1); end);
    end
  end);
end
module:hook('muc-occupant-joined', function(event)
  local origin, stanza, room = event.origin, event.stanza, event.room;
  if not stanza or util.is_admin(stanza.attr.from) or jid.host(stanza.attr.from) == recorder_domain then return; end
  local user = origin and origin.jitsi_meet_context_user;
  if not user or not user.id or not user.session_id then return; end
  report_participant_joined(user, jid.node(room.jid), 5);
end, 90);

-- Private control API. Never expose Prosody's HTTP port publicly.
module:depends('http');
module:provides('http', {
  default_path = '/ekyc-control';
  route = {
    ['POST /stop'] = function(event)
      if not secret or event.request.headers.x_internal_secret ~= secret then return 403; end
      local input = json.decode(event.request.body or '{}');
      if not input or type(input.room) ~= 'string' or #input.room > 80 or not input.room:match('^verifikasi%-[a-z0-9%-]+$') then return 400; end
      local muc = module:depends('muc');
      local room = muc.get_room_from_jid(input.room .. '@' .. module.host);
      if room then room:destroy(nil, 'Verification session ended'); end
      return 200;
    end;
  };
});
