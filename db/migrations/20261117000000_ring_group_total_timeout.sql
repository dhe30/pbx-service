-- migrate:up
-- Course spec §3 ring groups: "rung all at once or in order (each for a set time); timeout and
-- no-answer destination". ring_timeout_sec is the per-member time of a sequential group (the whole
-- ring time of an 'all' group); total_timeout_sec caps the whole group, after which the call goes to
-- no_answer_destination. NULL = no cap (sequential: every member gets its full ring time).
ALTER TABLE ring_groups
  ADD COLUMN total_timeout_sec integer CHECK (total_timeout_sec BETWEEN 5 AND 600);

-- migrate:down
ALTER TABLE ring_groups DROP COLUMN total_timeout_sec;
