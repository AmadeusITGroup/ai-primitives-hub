# Create REST API Endpoint

Generate secure, well-structured REST API endpoints with proper error handling and validation.

## Objectives

1. Follow RESTful conventions (GET, POST, PUT, DELETE)
2. Implement proper HTTP status codes
3. Add request validation
4. Handle errors gracefully
5. Include authentication/authorization
6. Add API documentation

## Endpoint Template

```javascript
/**
 * @route   POST /api/resource
 * @desc    Create new resource
 * @access  Private
 */
router.post('/', 
  auth,
  validateRequest,
  async (req, res) => {
    try {
      const { field1, field2 } = req.body;
      
      // Business logic
      const resource = await ResourceService.create({
        field1,
        field2,
        userId: req.user.id
      });
      
      res.status(201).json({
        success: true,
        data: resource
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        success: false,
        error: 'Server error'
      });
    }
  }
);
```

Create production-ready API endpoints\!
