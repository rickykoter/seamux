//! seamux://focus links (ADR 0086): how a process outside the app, such as
//! crew-resume, the sweep or a board in a plain browser, asks the app to
//! show a pane. The link only brings a pane forward. It carries a workspace
//! id and, optionally, a pane id, both UUIDs. Nothing else in it is read.

/// The scheme the app registers in its Info.plist (install.sh).
pub const SCHEME: &str = "seamux";

/// `seamux://focus?ws=<ws>[&pane=<pane>]`, or None when an id is not a UUID.
pub fn url(ws: &str, pane: Option<&str>) -> Option<String> {
    if !cmux::is_uuid(ws) {
        return None;
    }
    match pane.filter(|p| !p.is_empty()) {
        Some(p) if cmux::is_uuid(p) => Some(format!("{SCHEME}://focus?ws={ws}&pane={p}")),
        Some(_) => None,
        None => Some(format!("{SCHEME}://focus?ws={ws}")),
    }
}

/// The workspace and pane a link names, when it is a well-formed focus link.
/// Unknown fields are ignored; a repeated or non-UUID ws or pane drops the link.
pub fn parse(link: &str) -> Option<(String, Option<String>)> {
    let rest = link.strip_prefix(&format!("{SCHEME}://"))?;
    let (host, query) = rest.split_once('?').unwrap_or((rest, ""));
    if host.trim_end_matches('/') != "focus" {
        return None;
    }
    let (mut ws, mut pane): (Option<&str>, Option<&str>) = (None, None);
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let slot = match k {
            "ws" => &mut ws,
            "pane" => &mut pane,
            _ => continue,
        };
        if slot.is_some() || !cmux::is_uuid(v) {
            return None;
        }
        *slot = Some(v);
    }
    Some((ws?.to_string(), pane.map(String::from)))
}

/// Ask the app to show `ws` (and `pane`) through macOS `open`. False when the
/// ids are not UUIDs or `open` failed (no app has registered the scheme).
pub fn open(ws: &str, pane: Option<&str>) -> bool {
    let Some(link) = url(ws, pane) else { return false };
    std::process::Command::new("/usr/bin/open")
        .arg(&link)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: &str = "F7C77CFC-3416-43EA-BD60-2CEB74953A19";
    const P: &str = "7B07A98B-825F-427E-9389-23086C5E3F90";

    #[test]
    fn a_link_round_trips_with_and_without_its_pane() {
        assert_eq!(parse(&url(W, Some(P)).unwrap()), Some((W.into(), Some(P.into()))));
        assert_eq!(parse(&url(W, None).unwrap()), Some((W.into(), None)));
        assert_eq!(url(W, Some("")), url(W, None));
    }

    #[test]
    fn ids_that_are_not_uuids_make_no_link() {
        assert_eq!(url("workspace:3", None), None);
        assert_eq!(url(W, Some("x; rm -rf ~")), None);
        assert_eq!(parse(&format!("seamux://focus?ws={W}&pane=nope")), None);
        assert_eq!(parse("seamux://focus?pane=nope"), None);
        assert_eq!(parse(&format!("seamux://focus?pane={P}")), None);
    }

    #[test]
    fn only_focus_is_read_and_extra_fields_are_ignored() {
        assert_eq!(parse(&format!("seamux://focus?ws={W}&answer=2")), Some((W.into(), None)));
        assert_eq!(parse(&format!("seamux://answer?ws={W}")), None);
        assert_eq!(parse(&format!("http://focus?ws={W}")), None);
        assert_eq!(parse(&format!("seamux://focus?ws={W}&ws={W}")), None);
    }
}
