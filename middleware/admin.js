/**
 * Admin-only gate.
 * Must be used AFTER authenticate middleware.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.is_admin !== 1) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required',
    });
  }
  next();
}

module.exports = { requireAdmin };
