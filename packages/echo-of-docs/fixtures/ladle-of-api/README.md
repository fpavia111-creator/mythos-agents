# Ladle of API (`ladle-of-api`)

> A fictional client for the Ladle Recipes API. MIT, Node ≥ 20.

## Endpoints

| Endpoint | What it does |
|---|---|
| `GET /v1/recipes` | List recipes |
| `PUT /recipes/{id}` | Replace a recipe |
| `POST /recipes/{recipeId}` | Update a recipe |
| `DELETE /recipes/{id}/tags` | Remove all tags |
| `GET /recipes/search` | Search recipes by tag |

```bash
curl -X GET https://api.example.com/v1/recipes/42
```

## License

MIT
