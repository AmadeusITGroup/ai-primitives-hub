# Add Input Validation

Implement comprehensive input validation to prevent security vulnerabilities and data corruption.

## Validation Layers

1. **Schema Validation**: Structure and types
2. **Business Rules**: Domain-specific constraints
3. **Sanitization**: Remove malicious content
4. **Format Validation**: Email, phone, etc.

## Using Joi/Zod

```javascript
const Joi = require('joi');

const userSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).pattern(/[A-Z]/).pattern(/[0-9]/).required(),
  age: Joi.number().integer().min(13).max(120),
  role: Joi.string().valid('user', 'admin').default('user')
});

// Middleware
const validate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, { abortEarly: false });
  
  if (error) {
    return res.status(400).json({
      success: false,
      errors: error.details.map(d => d.message)
    });
  }
  
  req.validated = value;
  next();
};
```

Protect your API with validation\!
