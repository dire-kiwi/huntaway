use super::approved_by_reviews;
use serde_json::json;

fn pr(decision: Value, reviews: &[(&str, &str)]) -> Value {
    json!({"reviewDecision": decision, "reviews": reviews.iter().map(|(a, s)| json!({"author": {"login": a}, "state": s, "authorAssociation": "MEMBER"})).collect::<Vec<_>>()})
}
use serde_json::Value;

// HA-113: a comment after an approval (or a change request) doesn't replace the reviewer's verdict.
#[test]
fn a_reviewers_standing_verdict_survives_their_comments() {
    assert!(approved_by_reviews(&pr(json!("APPROVED"), &[])));
    assert!(!approved_by_reviews(&pr(json!("CHANGES_REQUESTED"), &[("a", "APPROVED")])));
    assert!(approved_by_reviews(&pr(json!(""), &[("a", "APPROVED"), ("a", "COMMENTED")])));
    assert!(!approved_by_reviews(&pr(json!(null), &[("a", "CHANGES_REQUESTED"), ("a", "COMMENTED"), ("b", "APPROVED")])));
    assert!(approved_by_reviews(&pr(json!(null), &[("a", "CHANGES_REQUESTED"), ("a", "APPROVED")])));
    assert!(!approved_by_reviews(&pr(json!(null), &[("a", "APPROVED"), ("a", "DISMISSED")])));
    assert!(!approved_by_reviews(&pr(json!(null), &[("a", "COMMENTED")])));
    // Required reviews not met: an approval GitHub doesn't count is no approval.
    assert!(!approved_by_reviews(&pr(json!("REVIEW_REQUIRED"), &[("a", "APPROVED")])));
    // Without required reviews, an outside account's approval doesn't count.
    let outsider = json!({"reviewDecision": "", "reviews": [{"author": {"login": "x"}, "state": "APPROVED", "authorAssociation": "NONE"}]});
    assert!(!approved_by_reviews(&outsider));
}
