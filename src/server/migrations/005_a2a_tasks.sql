-- Lesson 15. A2A tasks, kept in Postgres so a task waiting for a reviewer is still there after a
-- restart. The table is the one @a2a-js/sdk's DatabaseTaskStore reads and writes (its
-- taskStoreMigrations, written here as SQL so it runs with the app's other migrations).
-- Each row is scoped by tenant and owner: one caller never loads another caller's task.
CREATE TABLE a2a_tasks (
  tenant varchar(255) COLLATE "C" NOT NULL,
  owner varchar(255) COLLATE "C" NOT NULL,
  id varchar(36) COLLATE "C" NOT NULL,
  context_id varchar(36) COLLATE "C" NOT NULL,
  status_last_updated bigint NOT NULL,
  status_state varchar(255) COLLATE "C",
  status text,
  artifacts text,
  history text,
  metadata text,
  protocol_version varchar(255) COLLATE "C",
  PRIMARY KEY (tenant, owner, id)
);
CREATE INDEX a2a_tasks_scope_updated_idx ON a2a_tasks (tenant, owner, status_last_updated, id);
CREATE INDEX a2a_tasks_scope_context_updated_idx ON a2a_tasks (tenant, owner, context_id, status_last_updated, id);

-- Which task waits on which inbox item. When a reviewer decides the item, every task waiting on
-- it moves on: completed when approved, rejected when sent back.
CREATE TABLE a2a_task_reviews (
  item_id text NOT NULL REFERENCES review_items (id),
  task_id varchar(36) NOT NULL,
  tenant varchar(255) NOT NULL,
  owner varchar(255) NOT NULL,
  PRIMARY KEY (item_id, task_id)
);
