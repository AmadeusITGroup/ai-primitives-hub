# Node.js Standards

Follow these Node.js coding standards for production-quality backend applications.

## Project Structure

```
src/
├── controllers/    # Request handlers
├── models/        # Data models
├── services/      # Business logic
├── middleware/    # Express middleware
├── routes/        # API routes
├── utils/         # Utilities
└── config/        # Configuration
```

## Best Practices

- **Async/Await**: Use instead of callbacks
- **Error Handling**: Centralized error middleware
- **Environment Variables**: Use dotenv
- **Logging**: Use Winston or Pino
- **Security**: Helmet, rate limiting, CORS
- **Testing**: Jest or Mocha

## Code Style

```javascript
// ✅ Good: Async/await with error handling
async function getUser(id) {
  try {
    const user = await User.findById(id);
    if (\!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  } catch (error) {
    logger.error('Error fetching user:', error);
    throw error;
  }
}

// ✅ Good: Environment configuration
const config = {
  port: process.env.PORT || 3000,
  dbUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET
};
```

Write production-ready Node.js code\!
