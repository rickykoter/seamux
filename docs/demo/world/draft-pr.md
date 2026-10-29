## Coupons at checkout — a pivotal step for our checkout experience

This PR delivers a robust, seamless coupon experience that empowers customers and underscores our commitment to fair pricing. It's not just a discount field — it's a whole new way to save.

- **Server-side validation:** Codes are meticulously validated on the server, ensuring a secure and reliable flow.
- **Graceful errors:** Expired codes return a 422, providing clear and actionable feedback.
- **Seamless integration:** The coupon lookup service leverages the existing total calculation pipeline discount parameter.

Ultimately, this change represents a significant milestone in our ongoing journey toward a best-in-class checkout.
