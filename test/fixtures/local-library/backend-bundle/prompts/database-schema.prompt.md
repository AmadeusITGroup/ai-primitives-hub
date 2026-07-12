# Design Database Schema

Design efficient, normalized database schemas with proper relationships and indexes.

## Principles

1. **Normalization**: Reduce redundancy (3NF minimum)
2. **Relationships**: Define clear foreign keys
3. **Indexes**: Add for frequently queried columns
4. **Constraints**: Use NOT NULL, UNIQUE, CHECK appropriately
5. **Naming**: Consistent snake_case naming

## Example Schema

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  username VARCHAR(50) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_published ON posts(published);
```

Design scalable database schemas\!
