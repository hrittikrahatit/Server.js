-- KEYS[1] = download:<token>
-- Returns { s3Key, remaining_after_decrement } on success
-- Returns nil if missing/expired
-- Returns "NODL" if downloads_left <= 0

local key = KEYS[1]
if redis.call('EXISTS', key) == 0 then
  return nil
end

local downloads_left = tonumber(redis.call('HGET', key, 'downloads_left') or '0')
if downloads_left <= 0 then
  return 'NODL'
end

local new_val = redis.call('HINCRBY', key, 'downloads_left', -1)
local s3Key = redis.call('HGET', key, 's3Key')
return { s3Key, tostring(new_val) }
